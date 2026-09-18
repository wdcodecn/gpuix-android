fn main() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let libraries = root.join("../.build/hermes-android");
    println!("cargo:rustc-link-search=native={}", libraries.display());
    println!("cargo:rustc-link-lib=dylib=gpuix_js");
    println!("cargo:rerun-if-changed=../.build/app.js");
    println!("cargo:rerun-if-changed=../.build/hermes-android/libgpuix_js.so");
}
