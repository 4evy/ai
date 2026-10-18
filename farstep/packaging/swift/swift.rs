use std::path::PathBuf;
use std::process::Command;
use std::{env, fs};

struct Bridge {
    crate_name: &'static str,
    library: &'static str,
    deployment: &'static str,
    screen_capture: bool,
    modules: &'static [(&'static str, &'static str)],
    frameworks: &'static [&'static str],
}

const BRIDGES: &[Bridge] = &[
    Bridge {
        crate_name: "axuielement",
        library: "AXUIElementBridge",
        deployment: "10.13",
        screen_capture: false,
        modules: &[("AXUIElementBridge", "AXUIElementBridge")],
        frameworks: &[
            "ApplicationServices",
            "CoreFoundation",
            "CoreGraphics",
            "Foundation",
        ],
    },
    Bridge {
        crate_name: "apple-cf",
        library: "AppleCFBridge",
        deployment: "13.0",
        screen_capture: false,
        modules: &[
            ("CoreGraphicsBridge", "CoreGraphicsBridge"),
            ("IOSurfaceBridge", "IOSurfaceBridge"),
            ("DispatchBridge", "DispatchBridge"),
            ("CoreMediaBridge", "CoreMediaBridge"),
            ("CoreVideoBridge", "CoreVideoBridge"),
            ("CoreFoundationBridge", "CoreFoundationBridge"),
            ("AppleCFBridge", "AppleCFBridge"),
        ],
        frameworks: &[
            "CoreGraphics",
            "IOSurface",
            "CoreFoundation",
            "CoreMedia",
            "CoreVideo",
            "Metal",
            "Foundation",
        ],
    },
    Bridge {
        crate_name: "apple-metal",
        library: "AppleMetalSwiftBridge",
        deployment: "11.0",
        screen_capture: false,
        modules: &[("AppleMetalSwiftBridge", "AppleMetalBridge")],
        frameworks: &["Metal", "MetalFX", "Foundation", "IOSurface"],
    },
    Bridge {
        crate_name: "screencapturekit",
        library: "ScreenCaptureKitBridge",
        deployment: "13.0",
        screen_capture: true,
        modules: &[
            ("ScreenCaptureKitCoreMediaBridge", "CoreMedia"),
            ("MetalBridge", "Metal"),
            ("ScreenCaptureKitBridge", "ScreenCaptureKitBridge"),
        ],
        frameworks: &[
            "ScreenCaptureKit",
            "Foundation",
            "CoreGraphics",
            "CoreMedia",
            "IOSurface",
        ],
    },
];

struct Compiler {
    target: String,
    sdk: String,
    out: PathBuf,
    cache: PathBuf,
    defines: Vec<String>,
}

impl Compiler {
    fn new(bridge: &Bridge) -> Self {
        let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            other => panic!("unsupported Swift target architecture: {other}"),
        };
        let target = format!("{arch}-apple-macosx{}", bridge.deployment);
        let sdk = env::var("SDKROOT").expect("Nix must provide SDKROOT");
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        let cache = out.join("module-cache");
        fs::create_dir_all(&cache).unwrap();
        let defines = if bridge.screen_capture {
            screen_capture_defines()
        } else {
            Vec::new()
        };
        Self {
            target,
            sdk,
            out,
            cache,
            defines,
        }
    }

    fn module(&self, module: &str, directory: &str) -> PathBuf {
        let sources = PathBuf::from("swift-bridge/Sources").join(directory);
        let mut files: Vec<_> = fs::read_dir(sources)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "swift")
            })
            .collect();
        files.sort();
        let object = self.out.join(format!("{module}.o"));
        let mut compiler = Command::new("swiftc");
        compiler
            .args([
                "-O",
                "-whole-module-optimization",
                "-parse-as-library",
                "-swift-version",
                "5",
                "-target",
                &self.target,
                "-sdk",
                &self.sdk,
                "-module-name",
                module,
                "-emit-object",
                "-emit-module",
                "-module-cache-path",
            ])
            .arg(&self.cache)
            .arg("-emit-module-path")
            .arg(self.out.join(format!("{module}.swiftmodule")))
            .arg("-I")
            .arg(&self.out)
            .args(&self.defines)
            .args(files)
            .arg("-o")
            .arg(&object);
        if module == "AXUIElementBridge" {
            compiler.args(["-I", "swift-bridge/Sources/AXUIElementLegacyAPI"]);
        }
        assert!(
            compiler.status().unwrap().success(),
            "Swift bridge compilation failed"
        );
        object
    }

    fn build(&self, bridge: &Bridge) {
        let objects: Vec<_> = bridge
            .modules
            .iter()
            .map(|(module, directory)| self.module(module, directory))
            .collect();
        let archive = self.out.join(format!("lib{}.a", bridge.library));
        assert!(
            Command::new("ar")
                .arg("crs")
                .arg(archive)
                .args(objects)
                .status()
                .unwrap()
                .success(),
            "Swift bridge archiving failed"
        );
        println!("cargo:rustc-link-search=native={}", self.out.display());
        println!("cargo:rustc-link-lib=static={}", bridge.library);
        for framework in bridge.frameworks {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rustc-link-search=native={}/usr/lib/swift", self.sdk);
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}

// Apple's numeric SDK version is major * 10000 + minor * 100
const fn sdk_version(major: u32, minor: u32) -> u32 {
    major * 10_000 + minor * 100
}

fn screen_capture_defines() -> Vec<String> {
    let version: u32 = env::var("NIX_APPLE_SDK_VERSION")
        .expect("Nix must provide its Apple SDK version")
        .parse()
        .unwrap();
    assert!(
        version >= sdk_version(13, 0),
        "ScreenCaptureKit requires SDK 13.0"
    );
    let mut defines = Vec::new();
    if version >= sdk_version(13, 1) {
        defines.push("-DSCREENCAPTUREKIT_HAS_MACOS13_1_SDK".to_owned());
    }
    for (feature, minimum, define) in [
        ("MACOS_14_0", sdk_version(14, 0), "MACOS14"),
        ("MACOS_14_2", sdk_version(14, 2), "MACOS14_2"),
        ("MACOS_14_4", sdk_version(14, 4), "MACOS14_4"),
        ("MACOS_15_0", sdk_version(15, 0), "MACOS15"),
        ("MACOS_15_2", sdk_version(15, 2), "MACOS15_2"),
        ("MACOS_26_0", sdk_version(26, 0), "MACOS26"),
    ] {
        if env::var_os(format!("CARGO_FEATURE_{feature}")).is_some() {
            assert!(version >= minimum, "SDK cannot satisfy feature {feature}");
            defines.push(format!("-DSCREENCAPTUREKIT_HAS_{define}_SDK"));
        }
    }
    defines
}

// Compile the locked Apple bridge crates without SwiftPM or Xcode discovery
// Keep module names and framework links aligned with their Package.swift files
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=swift-bridge");
    println!("cargo:rerun-if-env-changed=SDKROOT");
    println!("cargo:rerun-if-env-changed=NIX_APPLE_SDK_VERSION");
    if env::var_os("DOCS_RS").is_some() {
        return;
    }
    let name = env::var("CARGO_PKG_NAME").unwrap();
    let bridge = BRIDGES
        .iter()
        .find(|bridge| bridge.crate_name == name)
        .unwrap_or_else(|| panic!("unsupported Swift bridge crate: {name}"));
    Compiler::new(bridge).build(bridge);
}
