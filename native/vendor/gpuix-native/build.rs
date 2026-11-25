extern crate napi_build;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        // gpuix-native declares crate-type = ["cdylib", "rlib"]; allow its cdylib
        // target to link when N-API symbols are supplied by libgpuix_js at runtime.
        println!("cargo:rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup");
    } else {
        napi_build::setup();
    }
}
