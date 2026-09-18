use serde::{Deserialize, Deserializer, Serialize};

/// Font weight value — accepts both CSS strings ("bold", "700") and numbers (700).
/// JS style objects commonly use both `fontWeight: "bold"` and `fontWeight: 700`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FontWeightValue {
    Num(f64),
    Str(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxShadowValue {
    pub offset_x: f64,
    pub offset_y: f64,
    pub blur_radius: f64,
    pub spread_radius: f64,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearGradientStopValue {
    pub color: String,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum GradientValue {
    #[serde(rename = "linear-gradient")]
    LinearGradient {
        angle: f64,
        stops: [LinearGradientStopValue; 2],
        #[serde(rename = "colorSpace")]
        color_space: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BackgroundValue {
    Color(String),
    Gradient(Box<GradientValue>),
}

/// A dimension value that can be a number (pixels) or a string (percentage, auto, etc.)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum DimensionValue {
    Pixels(f64),
    Percentage(f64), // 0.0 to 1.0
    Auto,
}

impl Default for DimensionValue {
    fn default() -> Self {
        DimensionValue::Auto
    }
}

impl<'de> Deserialize<'de> for DimensionValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::{self, Visitor};

        struct DimensionVisitor;

        impl<'de> Visitor<'de> for DimensionVisitor {
            type Value = DimensionValue;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a number or a string like '100%' or 'auto'")
            }

            fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DimensionValue::Pixels(v))
            }

            fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DimensionValue::Pixels(v as f64))
            }

            fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DimensionValue::Pixels(v as f64))
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if v == "auto" {
                    Ok(DimensionValue::Auto)
                } else if v.ends_with('%') {
                    let num_str = v.trim_end_matches('%');
                    match num_str.parse::<f64>() {
                        Ok(n) => Ok(DimensionValue::Percentage(n / 100.0)),
                        Err(_) => Err(de::Error::custom(format!("invalid percentage: {}", v))),
                    }
                } else {
                    // Try to parse as a number
                    match v.parse::<f64>() {
                        Ok(n) => Ok(DimensionValue::Pixels(n)),
                        Err(_) => Err(de::Error::custom(format!("invalid dimension: {}", v))),
                    }
                }
            }
        }

        deserializer.deserialize_any(DimensionVisitor)
    }
}

/// Style description that can be serialized from JS
/// Note: This is only used for JSON deserialization, not direct napi binding
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleDesc {
    // Display
    pub display: Option<String>,
    pub visibility: Option<String>,

    // Flexbox
    pub flex_direction: Option<String>,
    pub flex_wrap: Option<String>,
    pub flex_grow: Option<f64>,
    pub flex_shrink: Option<f64>,
    pub flex_basis: Option<f64>,
    pub align_items: Option<String>,
    pub align_self: Option<String>,
    pub align_content: Option<String>,
    pub justify_content: Option<String>,
    pub gap: Option<f64>,
    pub row_gap: Option<f64>,
    pub column_gap: Option<f64>,
    pub grid_template_columns: Option<f64>,
    pub grid_template_rows: Option<f64>,
    pub grid_column_min: Option<String>,
    pub grid_row_min: Option<String>,

    // Sizing - now supports both numbers and strings like "100%" or "auto"
    pub width: Option<DimensionValue>,
    pub height: Option<DimensionValue>,
    pub min_width: Option<DimensionValue>,
    pub min_height: Option<DimensionValue>,
    pub max_width: Option<DimensionValue>,
    pub max_height: Option<DimensionValue>,

    // Spacing (padding)
    pub padding: Option<f64>,
    pub padding_top: Option<f64>,
    pub padding_right: Option<f64>,
    pub padding_bottom: Option<f64>,
    pub padding_left: Option<f64>,

    // Spacing (margin)
    pub margin: Option<f64>,
    pub margin_top: Option<f64>,
    pub margin_right: Option<f64>,
    pub margin_bottom: Option<f64>,
    pub margin_left: Option<f64>,

    // Position
    pub position: Option<String>,
    pub top: Option<f64>,
    pub right: Option<f64>,
    pub bottom: Option<f64>,
    pub left: Option<f64>,

    // Background & Colors
    pub background: Option<BackgroundValue>,
    pub background_color: Option<String>,
    pub color: Option<String>,
    pub opacity: Option<f64>,

    // Border
    pub border_width: Option<f64>,
    pub border_top_width: Option<f64>,
    pub border_right_width: Option<f64>,
    pub border_bottom_width: Option<f64>,
    pub border_left_width: Option<f64>,
    pub border_color: Option<String>,
    pub border_radius: Option<f64>,
    pub border_top_left_radius: Option<f64>,
    pub border_top_right_radius: Option<f64>,
    pub border_bottom_left_radius: Option<f64>,
    pub border_bottom_right_radius: Option<f64>,
    pub box_shadow: Option<BoxShadowValue>,

    // Text
    pub font_size: Option<f64>,
    pub font_family: Option<String>,
    pub font_weight: Option<FontWeightValue>,
    pub text_align: Option<String>,
    pub line_height: Option<f64>,
    pub white_space: Option<String>,
    pub text_overflow: Option<String>,
    pub line_clamp: Option<f64>,
    pub text_decoration: Option<String>,

    // Overflow
    pub overflow: Option<String>,
    pub overflow_x: Option<String>,
    pub overflow_y: Option<String>,

    // Cursor
    pub cursor: Option<String>,
    /// `"auto"` blocks mouse hits behind this element. `"none"` never does.
    /// Unset: block when this element paints a fill or is absolutely positioned.
    pub pointer_events: Option<String>,

    // Text selection. "none" opts an element and its subtree out of the
    // selection registry, so buttons and toolbars never start a drag.
    // Inherited down the tree like the CSS property of the same name.
    pub user_select: Option<String>,
    /// Selection wash colour for this subtree. Defaults to the theme accent at
    /// 35% opacity, the same tone Comet uses.
    pub selection_color: Option<String>,

    // Pseudo-selector styles — applied by GPUI natively (no JS round-trip).
    // Uses Box to avoid infinite-size struct (StyleDesc contains StyleDesc).
    pub hover: Option<Box<StyleDesc>>,
    pub active: Option<Box<StyleDesc>>,
}

pub use crate::color::{parse_color, parse_color_hex};

impl BackgroundValue {
    fn resolve(&self) -> Option<gpui::Background> {
        match self {
            Self::Color(value) => crate::color::parse_color_rgba(value).map(Into::into),
            Self::Gradient(gradient) => {
                let GradientValue::LinearGradient {
                    angle,
                    stops,
                    color_space,
                } = gradient.as_ref();
                let angle = *angle as f32;
                let [from, to] = stops;
                let from_position = from.position as f32;
                let to_position = to.position as f32;
                if !angle.is_finite()
                    || !(0.0..=1.0).contains(&from_position)
                    || !(0.0..=1.0).contains(&to_position)
                {
                    return None;
                }

                let color_space = match color_space.as_deref() {
                    None | Some("srgb") => gpui::ColorSpace::Srgb,
                    Some("oklab") => gpui::ColorSpace::Oklab,
                    _ => return None,
                };
                Some(
                    gpui::linear_gradient(
                        angle,
                        gpui::linear_color_stop(
                            crate::color::parse_color_rgba(&from.color)?,
                            from_position,
                        ),
                        gpui::linear_color_stop(
                            crate::color::parse_color_rgba(&to.color)?,
                            to_position,
                        ),
                    )
                    .color_space(color_space),
                )
            }
        }
    }
}

impl StyleDesc {
    pub(crate) fn has_background(&self) -> bool {
        self.background_color.is_some() || self.background.is_some()
    }

    pub(crate) fn resolved_background(&self) -> Option<gpui::Background> {
        if let Some(value) = self.background_color.as_deref() {
            return crate::color::parse_color_rgba(value).map(Into::into);
        }
        self.background.as_ref()?.resolve()
    }
}

/// Whether this style should insert a mouse hitbox.
///
/// GPUI only hit-tests elements that own a hitbox. A painted overlay without
/// one stays visible while clicks fall through. CSS `pointer-events` maps
/// here: `none` never blocks, `auto` always does. Unset follows the painted
/// surface: a fill or an absolute/fixed box blocks.
///
/// In-flow fills use BlockMouseExceptScroll so a parent scroller still gets
/// the wheel. `occlude()` (BlockMouse) is only for overlays that steal it.
pub fn should_occlude(style: &StyleDesc) -> bool {
    match style.pointer_events.as_deref() {
        Some("none") => return false,
        Some("auto") => return true,
        _ => {}
    }
    if matches!(style.position.as_deref(), Some("absolute") | Some("fixed")) {
        return true;
    }
    if !style.has_background() {
        return false;
    }
    match style.resolved_background() {
        Some(background) => !background.is_transparent(),
        None => true,
    }
}

/// Map a CSS `cursor` keyword onto a GPUI cursor. Unknown keywords return
/// `None` so the property is ignored, like every other invalid style value.
///
/// `ResizeUpLeftDownRight` is the NorthWest/SouthEast cursor on every backend,
/// so it is `nwse-resize`. GPUI's doc comments and its browser backend named
/// the opposite CSS values until the pinned fork corrected them, so do not
/// "fix" this pair back by reading an older GPUI.
pub fn parse_cursor(name: &str) -> Option<gpui::CursorStyle> {
    use gpui::CursorStyle;
    Some(match name {
        "default" | "auto" => CursorStyle::Arrow,
        "pointer" => CursorStyle::PointingHand,
        "text" => CursorStyle::IBeam,
        "vertical-text" => CursorStyle::IBeamCursorForVerticalLayout,
        "crosshair" => CursorStyle::Crosshair,
        "grab" => CursorStyle::OpenHand,
        "grabbing" | "move" | "all-scroll" => CursorStyle::ClosedHand,
        "col-resize" => CursorStyle::ResizeColumn,
        "row-resize" => CursorStyle::ResizeRow,
        "ew-resize" => CursorStyle::ResizeLeftRight,
        "ns-resize" => CursorStyle::ResizeUpDown,
        "nwse-resize" | "nw-resize" | "se-resize" => CursorStyle::ResizeUpLeftDownRight,
        "nesw-resize" | "ne-resize" | "sw-resize" => CursorStyle::ResizeUpRightDownLeft,
        "w-resize" => CursorStyle::ResizeLeft,
        "e-resize" => CursorStyle::ResizeRight,
        "n-resize" => CursorStyle::ResizeUp,
        "s-resize" => CursorStyle::ResizeDown,
        "not-allowed" | "no-drop" => CursorStyle::OperationNotAllowed,
        "alias" => CursorStyle::DragLink,
        "copy" => CursorStyle::DragCopy,
        "context-menu" => CursorStyle::ContextualMenu,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_fill(fill: &str) -> StyleDesc {
        StyleDesc {
            background_color: Some(fill.to_owned()),
            ..Default::default()
        }
    }

    #[test]
    fn transparent_function_does_not_occlude() {
        assert!(!should_occlude(&with_fill("transparent")));
        assert!(!should_occlude(&with_fill("oklch(50% 0.2 30 / 0%)")));
    }

    #[test]
    fn invalid_fill_keeps_conservative_occlusion() {
        assert!(should_occlude(&with_fill("not-a-color")));
    }

    #[test]
    fn resolves_a_two_stop_linear_gradient() {
        let style: StyleDesc = serde_json::from_str(
            r##"{"background":{"type":"linear-gradient","angle":90,"stops":[{"color":"#ff0000","position":0},{"color":"#0000ff","position":1}],"colorSpace":"oklab"}}"##,
        )
        .unwrap();
        let expected = gpui::linear_gradient(
            90.0,
            gpui::linear_color_stop(crate::color::parse_color_rgba("#ff0000").unwrap(), 0.0),
            gpui::linear_color_stop(crate::color::parse_color_rgba("#0000ff").unwrap(), 1.0),
        )
        .color_space(gpui::ColorSpace::Oklab);

        assert_eq!(style.resolved_background(), Some(expected));
    }

    #[test]
    fn transparent_gradient_does_not_occlude() {
        let style: StyleDesc = serde_json::from_str(
            r##"{"background":{"type":"linear-gradient","angle":0,"stops":[{"color":"transparent","position":0},{"color":"#00000000","position":1}]}}"##,
        )
        .unwrap();

        assert!(!should_occlude(&style));
    }

    #[test]
    fn maps_the_timeline_cursors() {
        assert_eq!(
            parse_cursor("col-resize"),
            Some(gpui::CursorStyle::ResizeColumn)
        );
        assert_eq!(parse_cursor("grab"), Some(gpui::CursorStyle::OpenHand));
        assert_eq!(
            parse_cursor("grabbing"),
            Some(gpui::CursorStyle::ClosedHand)
        );
        assert_eq!(
            parse_cursor("pointer"),
            Some(gpui::CursorStyle::PointingHand)
        );
        assert_eq!(parse_cursor("default"), Some(gpui::CursorStyle::Arrow));
    }

    #[test]
    fn ignores_an_unknown_cursor() {
        assert_eq!(parse_cursor("zoom-in"), None);
        assert_eq!(parse_cursor("POINTER"), None);
    }

    #[test]
    fn deserializes_text_decoration() {
        let style: StyleDesc = serde_json::from_str(r#"{"textDecoration":"underline"}"#).unwrap();
        assert_eq!(style.text_decoration.as_deref(), Some("underline"));

        let style: StyleDesc =
            serde_json::from_str(r#"{"textDecoration":"line-through"}"#).unwrap();
        assert_eq!(style.text_decoration.as_deref(), Some("line-through"));

        let style: StyleDesc = serde_json::from_str(r#"{"textDecoration":"none"}"#).unwrap();
        assert_eq!(style.text_decoration.as_deref(), Some("none"));
    }
}
