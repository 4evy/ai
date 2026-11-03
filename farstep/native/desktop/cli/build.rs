#![forbid(unsafe_code)]

fn main() {
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
    {
        // ScreenCaptureKit's Swift bridge uses the system concurrency runtime
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
