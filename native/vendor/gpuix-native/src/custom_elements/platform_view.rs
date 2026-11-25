//! Native platform view custom element (`<platform-view>`).
//!
//! Uses GPUI Mobile's hybrid composition view registry on Android (WebView,
//! video player, camera, maps, etc.) and renders a clean bordered placeholder on
//! desktop hosts so apps stay portable across targets.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::{custom_surface, CustomElement, CustomElementFactory, CustomRenderContext};

pub struct PlatformViewFactory;

impl CustomElementFactory for PlatformViewFactory {
    fn element_type(&self) -> &str {
        "platform-view"
    }

    fn create(&self, _id: u64) -> Box<dyn CustomElement> {
        Box::new(PlatformViewElement::default())
    }
}

#[derive(Default)]
struct PlatformViewElement {
    view_type: String,
    url: String,
    html: String,
    visible: Option<bool>,
    z_index: Option<i32>,
    params: HashMap<String, String>,
    #[cfg(target_os = "android")]
    native_view: Arc<Mutex<Option<Arc<gpui_mobile::android::platform_view::AndroidPlatformView>>>>,
    #[cfg(target_os = "android")]
    last_bounds: Arc<Mutex<Option<(f32, f32, f32, f32)>>>,
    #[cfg(target_os = "android")]
    last_visible: Arc<Mutex<Option<bool>>>,
    #[cfg(target_os = "android")]
    last_z_index: Arc<Mutex<Option<i32>>>,
    #[cfg(target_os = "android")]
    needs_recreate: bool,
}

impl PlatformViewElement {
    #[cfg(target_os = "android")]
    fn dispose_native(&mut self) {
        if let Some(view) = self.native_view.lock().unwrap().take() {
            use gpui_mobile::platform_view::PlatformView as _;
            view.dispose();
        }
        *self.last_bounds.lock().unwrap() = None;
        *self.last_visible.lock().unwrap() = None;
        *self.last_z_index.lock().unwrap() = None;
    }

    #[cfg(target_os = "android")]
    fn merged_params(&self) -> HashMap<String, String> {
        let mut merged = self.params.clone();
        if !self.url.is_empty() {
            merged.insert("url".to_string(), self.url.clone());
        }
        if !self.html.is_empty() {
            merged.insert("html".to_string(), self.html.clone());
        }
        merged
    }
}

impl Drop for PlatformViewElement {
    fn drop(&mut self) {
        self.destroy();
    }
}

impl CustomElement for PlatformViewElement {
    fn render(
        &mut self,
        ctx: CustomRenderContext,
        _window: &mut gpui::Window,
        _cx: &mut gpui::Context<crate::renderer::GpuixView>,
    ) -> gpui::AnyElement {
        use gpui::prelude::*;

        let base = custom_surface(gpui::div().id(("platform-view", ctx.id)), &ctx);

        #[cfg(target_os = "android")]
        {
            if self.needs_recreate {
                self.dispose_native();
                self.needs_recreate = false;
            }
            let view_type = if self.view_type.is_empty() {
                "webview".to_string()
            } else {
                self.view_type.clone()
            };
            let creation_params = self.merged_params();
            let native_view = self.native_view.clone();
            let last_bounds = self.last_bounds.clone();
            let last_visible = self.last_visible.clone();
            let last_z_index = self.last_z_index.clone();
            let visible = self.visible.unwrap_or(true);
            let z_index = self.z_index.unwrap_or(1);

            let tracker = gpui::canvas(
                |_, _, _| (),
                move |bounds, _, _, _| {
                    use gpui_mobile::android::platform_view::AndroidPlatformView;
                    use gpui_mobile::platform_view::{
                        PlatformView as _, PlatformViewBounds, PlatformViewParams,
                    };

                    let x = f32::from(bounds.origin.x);
                    let y = f32::from(bounds.origin.y);
                    let width = f32::from(bounds.size.width);
                    let height = f32::from(bounds.size.height);
                    if width <= 0.5 || height <= 0.5 {
                        return;
                    }

                    let mut slot = native_view.lock().unwrap();
                    if slot.is_none() {
                        let params = PlatformViewParams {
                            bounds: PlatformViewBounds {
                                x,
                                y,
                                width,
                                height,
                            },
                            creation_params: creation_params.clone(),
                        };
                        match AndroidPlatformView::new(&view_type, &params) {
                            Ok(created) => {
                                let arc = Arc::new(created);
                                *last_bounds.lock().unwrap() = Some((x, y, width, height));
                                arc.set_visible(visible);
                                *last_visible.lock().unwrap() = Some(visible);
                                arc.set_z_index(z_index);
                                *last_z_index.lock().unwrap() = Some(z_index);
                                *slot = Some(arc);
                            }
                            Err(err) => {
                                log::warn!("PlatformView create failed ({view_type}): {err}");
                            }
                        }
                        return;
                    }

                    if let Some(view) = slot.as_ref() {
                        let mut prev_bounds = last_bounds.lock().unwrap();
                        let moved = match *prev_bounds {
                            Some((px, py, pw, ph)) => {
                                (px - x).abs() > 0.5
                                    || (py - y).abs() > 0.5
                                    || (pw - width).abs() > 0.5
                                    || (ph - height).abs() > 0.5
                            }
                            None => true,
                        };
                        if moved {
                            view.set_bounds(PlatformViewBounds {
                                x,
                                y,
                                width,
                                height,
                            });
                            *prev_bounds = Some((x, y, width, height));
                        }

                        let mut prev_visible = last_visible.lock().unwrap();
                        if *prev_visible != Some(visible) {
                            view.set_visible(visible);
                            *prev_visible = Some(visible);
                        }

                        let mut prev_z = last_z_index.lock().unwrap();
                        if *prev_z != Some(z_index) {
                            view.set_z_index(z_index);
                            *prev_z = Some(z_index);
                        }
                    }
                },
            )
            .size_full();

            return base.child(tracker).into_any_element();
        }

        #[cfg(not(target_os = "android"))]
        {
            let kind = if self.view_type.is_empty() {
                "platform-view"
            } else {
                self.view_type.as_str()
            };
            let label = if !self.url.is_empty() {
                format!("[PlatformView: {kind}] {}", self.url)
            } else if !self.html.is_empty() {
                format!("[PlatformView: {kind}] inline HTML ({} B)", self.html.len())
            } else {
                format!("[PlatformView: {kind}]")
            };
            base.flex()
                .items_center()
                .justify_center()
                .child(ctx.chrome_text(label, None))
                .into_any_element()
        }
    }

    fn set_prop(&mut self, key: &str, value: Value) {
        match key {
            "viewType" => {
                let next = value.as_str().unwrap_or("").to_string();
                if next != self.view_type {
                    self.view_type = next;
                    #[cfg(target_os = "android")]
                    {
                        self.needs_recreate = true;
                    }
                }
            }
            "url" => {
                let next = value.as_str().unwrap_or("").to_string();
                if next != self.url {
                    self.url = next;
                    #[cfg(target_os = "android")]
                    {
                        self.needs_recreate = true;
                    }
                }
            }
            "html" => {
                let next = value.as_str().unwrap_or("").to_string();
                if next != self.html {
                    self.html = next;
                    #[cfg(target_os = "android")]
                    {
                        self.needs_recreate = true;
                    }
                }
            }
            "visible" => {
                self.visible = value.as_bool();
            }
            "zIndex" => {
                self.z_index = value.as_i64().map(|n| n as i32);
            }
            "params" => {
                let mut parsed = HashMap::new();
                if let Some(map) = value.as_object() {
                    for (k, v) in map {
                        let s = match v {
                            Value::String(s) => s.clone(),
                            Value::Null => continue,
                            other => other.to_string(),
                        };
                        parsed.insert(k.clone(), s);
                    }
                }
                if parsed != self.params {
                    self.params = parsed;
                    #[cfg(target_os = "android")]
                    {
                        self.needs_recreate = true;
                    }
                }
            }
            _ => {}
        }
    }

    fn supported_props(&self) -> &'static [&'static str] {
        &["viewType", "url", "html", "visible", "zIndex", "params"]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        &["click"]
    }

    fn destroy(&mut self) {
        #[cfg(target_os = "android")]
        self.dispose_native();
    }
}
