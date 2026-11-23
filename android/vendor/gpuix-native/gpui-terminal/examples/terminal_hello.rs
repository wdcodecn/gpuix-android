//! Run inside kitty or Ghostty:
//!
//! ```sh
//! cargo run -p gpui_terminal --example terminal_hello
//! ```
//!
//! Press ctrl-c to quit.

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "freebsd"))]
mod app {
    use gpui::{
        App, Context, FocusHandle, MouseMoveEvent, Point, Window, WindowOptions, div, prelude::*,
        px, rgb,
    };

    struct Hello {
        focus_handle: FocusHandle,
        clicks: usize,
        mouse: Point<gpui::Pixels>,
        last_key: String,
    }

    impl Render for Hello {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let size = window.viewport_size();
            div()
                .id("root")
                .track_focus(&self.focus_handle)
                .size_full()
                .flex()
                .flex_col()
                .gap_4()
                .p_6()
                .bg(rgb(0x1e1e2e))
                .text_color(rgb(0xcdd6f4))
                .text_xl()
                .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                    this.mouse = event.position;
                    cx.notify();
                }))
                .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                    this.last_key = event.keystroke.unparse();
                    cx.notify();
                }))
                .child(format!(
                    "GPUI in a terminal. {}x{} px, mouse {:.0},{:.0}, last key {:?}",
                    size.width.as_f32(),
                    size.height.as_f32(),
                    self.mouse.x.as_f32(),
                    self.mouse.y.as_f32(),
                    self.last_key,
                ))
                .child(
                    div()
                        .id("button")
                        .px_4()
                        .py_2()
                        .w(px(220.))
                        .rounded_lg()
                        .bg(rgb(0x45475a))
                        .hover(|style| style.bg(rgb(0x89b4fa)).text_color(rgb(0x1e1e2e)))
                        .active(|style| style.bg(rgb(0xf38ba8)))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.clicks += 1;
                            cx.notify();
                        }))
                        .child(format!("Clicked {} times", self.clicks)),
                )
                .child(
                    div()
                        .id("list")
                        .flex_1()
                        .overflow_y_scroll()
                        .rounded_lg()
                        .border_1()
                        .border_color(rgb(0x585b70))
                        .children((0..200).map(|index| {
                            div()
                                .id(index)
                                .px_3()
                                .py_1()
                                .hover(|style| style.bg(rgb(0x313244)))
                                .child(format!("Row {index}"))
                        })),
                )
        }
    }

    pub fn main() -> anyhow::Result<()> {
        gpui_terminal::application()?.run(|cx: &mut App| {
            let window = cx.open_window(WindowOptions::default(), |window, cx| {
                cx.new(|cx| {
                    let focus_handle = cx.focus_handle();
                    window.focus(&focus_handle, cx);
                    Hello {
                        focus_handle,
                        clicks: 0,
                        mouse: Point::default(),
                        last_key: String::new(),
                    }
                })
            });
            if let Err(error) = window {
                log::error!("failed to open the terminal window: {error:#}");
                cx.quit();
            }
        });
        Ok(())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "freebsd"))]
fn main() -> anyhow::Result<()> {
    app::main()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "freebsd")))]
fn main() {
    eprintln!("gpui_terminal supports macOS, Linux and FreeBSD");
}
