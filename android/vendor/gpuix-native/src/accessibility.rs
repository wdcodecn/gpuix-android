//! GPUI accessibility props from React custom_props.
//!
//! A node reaches AccessKit only with both an `.id(...)` and a `.role(...)`.
//! GPUIX already sets the id. This module sets the role and ARIA fields.
//! Prop names match React DOM: `aria-label`, not `ariaLabel`.

use std::collections::HashMap;

use gpui::prelude::*;
use gpui::{AccessibleAction, Role};

use crate::element_tree::EventPayload;
use crate::renderer::{emit_event_full, EventCallback};

/// Apply `role` and `aria-*` from React, plus a default role when the app
/// did not set one. `none` / `presentation` produce no node.
pub(crate) fn apply_accessibility<E>(
    mut el: E,
    props: &HashMap<String, serde_json::Value>,
    default_role: Option<Role>,
) -> E
where
    E: StatefulInteractiveElement,
{
    let explicit = props.get("role").and_then(|value| value.as_str());
    if matches!(explicit, Some("none" | "presentation")) {
        return el;
    }

    let role = explicit
        .and_then(role_from_aria)
        .or(default_role)
        .filter(|role| *role != Role::GenericContainer);
    let Some(role) = role else {
        return el;
    };
    el = el.role(role);

    if let Some(id) = string_prop(props, "aria-id") {
        el = el.accessibility_id(id);
    }
    if let Some(label) = string_prop(props, "aria-label") {
        el = el.aria_label(label);
    }
    if let Some(description) = string_prop(props, "aria-description") {
        el = el.aria_description(description);
    }
    if let Some(value) = string_prop(props, "aria-valuetext") {
        el = el.aria_value(value);
    }
    if let Some(expanded) = bool_prop(props, "aria-expanded") {
        el = el.aria_expanded(expanded);
    }
    if let Some(selected) = bool_prop(props, "aria-selected") {
        el = el.aria_selected(selected);
    }
    if let Some(level) = usize_prop(props, "aria-level") {
        el = el.aria_level(level);
    }
    el
}

/// `aria-label`, or `alt` when that is empty. Used by `<img>`.
pub(crate) fn apply_image_label<E>(
    el: E,
    props: &HashMap<String, serde_json::Value>,
    alt: &str,
) -> E
where
    E: StatefulInteractiveElement,
{
    if props.get("aria-label").is_some() || alt.is_empty() {
        return el;
    }
    el.aria_label(alt.to_string())
}

/// VoiceOver Press. GPUI auto-adds Click only for `.on_click()`. GPUIX
/// click is `on_mouse_up`, so register the action by hand and emit the
/// same JS `click` event.
pub(crate) fn apply_a11y_click<E>(
    el: E,
    events: &std::collections::HashSet<String>,
    element_id: u64,
    callback: &Option<EventCallback>,
) -> E
where
    E: StatefulInteractiveElement,
{
    if !events.contains("click") {
        return el;
    }
    let callback = callback.clone();
    el.on_a11y_action(AccessibleAction::Click, move |_data, _window, _cx| {
        emit_event_full(
            &callback,
            element_id,
            "click",
            |payload: &mut EventPayload| {
                payload.button = Some(0);
                payload.click_count = Some(1);
                payload.is_right_click = Some(false);
            },
        );
    })
}

fn string_prop(props: &HashMap<String, serde_json::Value>, key: &str) -> Option<String> {
    props
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn bool_prop(props: &HashMap<String, serde_json::Value>, key: &str) -> Option<bool> {
    props.get(key).and_then(|value| value.as_bool())
}

fn usize_prop(props: &HashMap<String, serde_json::Value>, key: &str) -> Option<usize> {
    props
        .get(key)
        .and_then(|value| value.as_u64())
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

/// ARIA token → AccessKit role. Unknown tokens are ignored, like a bad style.
fn role_from_aria(token: &str) -> Option<Role> {
    Some(match token {
        "alert" => Role::Alert,
        "alertdialog" => Role::AlertDialog,
        "application" => Role::Application,
        "article" => Role::Article,
        "banner" => Role::Banner,
        "blockquote" => Role::Blockquote,
        "button" => Role::Button,
        "caption" => Role::Caption,
        "cell" => Role::Cell,
        "checkbox" => Role::CheckBox,
        "code" => Role::Code,
        "columnheader" => Role::ColumnHeader,
        "combobox" => Role::ComboBox,
        "complementary" => Role::Complementary,
        "contentinfo" => Role::ContentInfo,
        "definition" => Role::Definition,
        "deletion" => Role::ContentDeletion,
        "dialog" => Role::Dialog,
        "document" => Role::Document,
        "emphasis" => Role::Emphasis,
        "feed" => Role::Feed,
        "figure" => Role::Figure,
        "form" => Role::Form,
        "generic" => Role::GenericContainer,
        "grid" => Role::Grid,
        "gridcell" => Role::GridCell,
        "group" => Role::Group,
        "heading" => Role::Heading,
        "img" => Role::Image,
        "insertion" => Role::ContentInsertion,
        "link" => Role::Link,
        "list" => Role::List,
        "listbox" => Role::ListBox,
        "listitem" => Role::ListItem,
        "log" => Role::Log,
        "main" => Role::Main,
        "marquee" => Role::Marquee,
        "math" => Role::Math,
        "menu" => Role::Menu,
        "menubar" => Role::MenuBar,
        "menuitem" => Role::MenuItem,
        "menuitemcheckbox" => Role::MenuItemCheckBox,
        "menuitemradio" => Role::MenuItemRadio,
        "meter" => Role::Meter,
        "navigation" => Role::Navigation,
        "none" | "presentation" => Role::GenericContainer,
        "note" => Role::Note,
        "option" => Role::ListBoxOption,
        "paragraph" => Role::Paragraph,
        "progressbar" => Role::ProgressIndicator,
        "radio" => Role::RadioButton,
        "radiogroup" => Role::RadioGroup,
        "region" => Role::Region,
        "row" => Role::Row,
        "rowgroup" => Role::RowGroup,
        "rowheader" => Role::RowHeader,
        "scrollbar" => Role::ScrollBar,
        "search" => Role::Search,
        "searchbox" => Role::SearchInput,
        "separator" => Role::Splitter,
        "slider" => Role::Slider,
        "spinbutton" => Role::SpinButton,
        "status" => Role::Status,
        "strong" => Role::Strong,
        "subscript" => Role::GenericContainer,
        "superscript" => Role::GenericContainer,
        "switch" => Role::Switch,
        "tab" => Role::Tab,
        "table" => Role::Table,
        "tablist" => Role::TabList,
        "tabpanel" => Role::TabPanel,
        "term" => Role::Term,
        "textbox" => Role::TextInput,
        "time" => Role::Time,
        "timer" => Role::Timer,
        "toolbar" => Role::Toolbar,
        "tooltip" => Role::Tooltip,
        "tree" => Role::Tree,
        "treegrid" => Role::TreeGrid,
        "treeitem" => Role::TreeItem,
        _ => return None,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct A11yNodeSnapshot {
    pub id: u64,
    pub role: String,
    pub label: String,
    pub value: String,
    pub clickable: bool,
    pub checkable: bool,
    pub checked: bool,
    pub enabled: bool,
    pub focused: bool,
    /// Logical dp `[x, y, width, height]`; GpuiAccessibilityBridge scales by display density.
    pub bounds: [f64; 4],
}

fn collect_descendant_text(
    tree: &crate::retained_tree::RetainedTree,
    id: u64,
    out: &mut String,
) {
    let Some(el) = tree.elements.get(&id) else {
        return;
    };
    if let Some(content) = &el.content {
        if !content.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(content);
        }
    }
    for &child_id in &el.children {
        if out.len() >= 256 {
            break;
        }
        collect_descendant_text(tree, child_id, out);
    }
}

pub(crate) fn collect_android_a11y_tree(
    tree: &crate::retained_tree::RetainedTree,
    bounds: &HashMap<u64, crate::automation::ElementBounds>,
    focused_id: Option<u64>,
) -> Vec<A11yNodeSnapshot> {
    let Some(root_id) = tree.root_id else {
        return Vec::new();
    };
    let mut nodes = Vec::new();
    let mut stack = vec![root_id];

    while let Some(id) = stack.pop() {
        let Some(el) = tree.elements.get(&id) else {
            continue;
        };
        for &child in el.children.iter().rev() {
            stack.push(child);
        }

        let props = el.custom_props();
        let explicit_role = props.get("role").and_then(|v| v.as_str());
        if matches!(explicit_role, Some("none" | "presentation")) {
            continue;
        }

        let Some(b) = bounds.get(&id) else {
            continue;
        };
        if b.width <= 0.5 || b.height <= 0.5 {
            continue;
        }

        let clickable = el.events().contains("click");
        let aria_label = string_prop(props, "aria-label").unwrap_or_default();
        let aria_value = string_prop(props, "aria-valuetext").unwrap_or_default();
        let role_str = explicit_role
            .map(str::to_string)
            .unwrap_or_else(|| match el.element_type.as_str() {
                "input" | "textarea" => "textbox".to_string(),
                "img" => "img".to_string(),
                "text" => "text".to_string(),
                _ if clickable => "button".to_string(),
                _ => "generic".to_string(),
            });

        let aria_checked = props.get("aria-checked");
        let checkable = aria_checked.is_some()
            || matches!(role_str.as_str(), "checkbox" | "switch" | "radio");
        let checked = aria_checked
            .and_then(|v| v.as_bool())
            .or_else(|| aria_checked.and_then(|v| v.as_str()).map(|s| s == "true"))
            .unwrap_or(false);
        let enabled = !bool_prop(props, "aria-disabled").unwrap_or(false);
        let focused = focused_id == Some(id);

        let is_semantic = clickable
            || !aria_label.is_empty()
            || !aria_value.is_empty()
            || explicit_role.is_some()
            || matches!(el.element_type.as_str(), "input" | "textarea" | "img")
            || (el.element_type == "text"
                && el.content.as_ref().is_some_and(|c| !c.trim().is_empty()));

        if !is_semantic {
            continue;
        }

        let mut label = aria_label;
        if label.is_empty() {
            if el.element_type == "text" {
                label = el.content.clone().unwrap_or_default();
            } else if clickable {
                collect_descendant_text(tree, id, &mut label);
            } else if el.element_type == "img" {
                label = string_prop(props, "alt").unwrap_or_default();
            }
        }

        let value = if !aria_value.is_empty() {
            aria_value
        } else if matches!(el.element_type.as_str(), "input" | "textarea") {
            string_prop(props, "value").unwrap_or_default()
        } else {
            String::new()
        };

        nodes.push(A11yNodeSnapshot {
            id,
            role: role_str,
            label,
            value,
            clickable,
            checkable,
            checked,
            enabled,
            focused,
            bounds: [b.x, b.y, b.width, b.height],
        });
    }

    nodes
}

#[cfg(test)]
mod tests {
    use super::role_from_aria;
    use gpui::Role;

    #[test]
    fn maps_common_aria_tokens() {
        assert_eq!(role_from_aria("button"), Some(Role::Button));
        assert_eq!(role_from_aria("heading"), Some(Role::Heading));
        assert_eq!(role_from_aria("textbox"), Some(Role::TextInput));
        assert_eq!(role_from_aria("img"), Some(Role::Image));
        assert_eq!(role_from_aria("option"), Some(Role::ListBoxOption));
        assert_eq!(role_from_aria("none"), Some(Role::GenericContainer));
        assert_eq!(role_from_aria("presentation"), Some(Role::GenericContainer));
        assert_eq!(role_from_aria("Button"), None);
        assert_eq!(role_from_aria("not-a-role"), None);
    }
}
