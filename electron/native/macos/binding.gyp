{
  "targets": [
    {
      "target_name": "kente_mac_player",
      "sources": ["mac_player.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!@(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17", "-fexceptions", "-fobjc-arc", "-fblocks"],
      "link_settings": { "libraries": ["-framework Cocoa", "-framework QuartzCore"] },
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "OTHER_LDFLAGS": ["-framework Cocoa", "-framework QuartzCore"]
      }
    },
    {
      "target_name": "kente_mac_libretro",
      "sources": ["libretro_host.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")", "."],
      "dependencies": ["<!@(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17", "-fexceptions", "-fobjc-arc", "-fblocks"],
      "link_settings": { "libraries": ["-framework Cocoa", "-framework QuartzCore", "-framework AudioToolbox"] },
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "OTHER_LDFLAGS": ["-framework Cocoa", "-framework QuartzCore", "-framework AudioToolbox"]
      }
    }
  ]
}
