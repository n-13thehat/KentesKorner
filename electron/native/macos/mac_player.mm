#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>
#include <napi.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdlib>

namespace {

__strong NSView *g_hostView = nil;
__strong NSView *g_playerView = nil;
CGImageRef g_lastFrame = nullptr;

NSView *PlayerView() {
  NSView *view = [[NSView alloc] initWithFrame:NSZeroRect];
  view.wantsLayer = YES;
  view.layer.backgroundColor = NSColor.blackColor.CGColor;
  view.layer.contentsGravity = kCAGravityResizeAspect;
  view.layer.magnificationFilter = kCAFilterNearest;
  view.layer.minificationFilter = kCAFilterLinear;
  return view;
}

bool ReadNumber(Napi::Object value, const char *key, double *out) {
  Napi::Value member = value.Get(key);
  if (!member.IsNumber()) return false;
  double number = member.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number < 0 || number > 65536) return false;
  *out = number;
  return true;
}

bool SetFrame(NSView *host, NSView *view, Napi::Object rect) {
  double x, y, width, height, viewportWidth, viewportHeight;
  if (!ReadNumber(rect, "x", &x) || !ReadNumber(rect, "y", &y)
      || !ReadNumber(rect, "width", &width) || !ReadNumber(rect, "height", &height)
      || !ReadNumber(rect, "viewportWidth", &viewportWidth)
      || !ReadNumber(rect, "viewportHeight", &viewportHeight)
      || width < 1 || height < 1 || viewportWidth < 1 || viewportHeight < 1
      || x + width > viewportWidth + 2 || y + height > viewportHeight + 2) return false;

  NSRect bounds = host.bounds;
  CGFloat sx = NSWidth(bounds) / viewportWidth;
  CGFloat sy = NSHeight(bounds) / viewportHeight;
  NSRect frame = NSMakeRect(x * sx, NSHeight(bounds) - (y + height) * sy,
                            width * sx, height * sy);
  [view setFrame:frame];
  return true;
}

void DetachOnMain() {
  if (g_playerView) [g_playerView removeFromSuperview];
  g_playerView = nil;
  g_hostView = nil;
  if (g_lastFrame) {
    CGImageRelease(g_lastFrame);
    g_lastFrame = nil;
  }
}

void ReleaseFrameData(void *info, const void *data, size_t size) {
  (void)info;
  (void)size;
  std::free(const_cast<void *>(data));
}

Napi::Value Mount(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() != 2 || !info[0].IsBuffer() || !info[1].IsObject()) {
    Napi::TypeError::New(env, "mount requires the Electron NSView handle and player bounds").ThrowAsJavaScriptException();
    return env.Null();
  }
  auto handle = info[0].As<Napi::Buffer<uint8_t>>();
  if (handle.Length() != sizeof(void *)) {
    Napi::TypeError::New(env, "invalid macOS native view handle").ThrowAsJavaScriptException();
    return env.Null();
  }
  void *raw = nullptr;
  std::memcpy(&raw, handle.Data(), sizeof(raw));
  if (!raw) {
    Napi::TypeError::New(env, "empty macOS native view handle").ThrowAsJavaScriptException();
    return env.Null();
  }
  NSView *host = (__bridge NSView *)raw;
  if (!host || !host.window || !NSThread.isMainThread) {
    Napi::Error::New(env, "the Kente player view must be mounted on the AppKit main thread").ThrowAsJavaScriptException();
    return env.Null();
  }
  DetachOnMain();
  NSView *view = PlayerView();
  view.hidden = YES;
  if (!SetFrame(host, view, info[1].As<Napi::Object>())) {
    Napi::TypeError::New(env, "invalid player bounds").ThrowAsJavaScriptException();
    return env.Null();
  }
  [host addSubview:view positioned:NSWindowAbove relativeTo:nil];
  g_hostView = host;
  g_playerView = view;
  return Napi::Boolean::New(env, true);
}

Napi::Value Resize(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!g_hostView || !g_playerView || info.Length() != 1 || !info[0].IsObject())
    return Napi::Boolean::New(env, false);
  return Napi::Boolean::New(env, SetFrame(g_hostView, g_playerView, info[0].As<Napi::Object>()));
}

Napi::Value ViewHandle(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!g_playerView) return env.Null();
  void *raw = (__bridge void *)g_playerView;
  return Napi::Buffer<uint8_t>::Copy(env, reinterpret_cast<const uint8_t *>(&raw), sizeof(raw));
}

Napi::Value SetVisible(const Napi::CallbackInfo &info) {
  if (!g_playerView || info.Length() != 1 || !info[0].IsBoolean())
    return Napi::Boolean::New(info.Env(), false);
  g_playerView.hidden = !info[0].As<Napi::Boolean>().Value();
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value Present(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!g_playerView || info.Length() != 3 || !info[0].IsBuffer()
      || !info[1].IsNumber() || !info[2].IsNumber()) return Napi::Boolean::New(env, false);
  auto pixels = info[0].As<Napi::Buffer<uint8_t>>();
  uint32_t width = info[1].As<Napi::Number>().Uint32Value();
  uint32_t height = info[2].As<Napi::Number>().Uint32Value();
  if (!width || !height || width > 8192 || height > 8192
      || static_cast<uint64_t>(width) * height * 4 != pixels.Length()) return Napi::Boolean::New(env, false);

  void *frameBytes = std::malloc(pixels.Length());
  if (!frameBytes) return Napi::Boolean::New(env, false);
  std::memcpy(frameBytes, pixels.Data(), pixels.Length());
  CGDataProviderRef provider = CGDataProviderCreateWithData(nullptr, frameBytes, pixels.Length(), ReleaseFrameData);
  if (!provider) {
    std::free(frameBytes);
    return Napi::Boolean::New(env, false);
  }
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGImageRef frame = CGImageCreate(width, height, 8, 32, width * 4, colorSpace,
      kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast, provider, nullptr, false,
      kCGRenderingIntentDefault);
  CGColorSpaceRelease(colorSpace);
  CGDataProviderRelease(provider);
  if (!frame) return Napi::Boolean::New(env, false);

  if (g_lastFrame) CGImageRelease(g_lastFrame);
  g_lastFrame = frame;
  g_playerView.layer.contents = (__bridge id)frame;
  return Napi::Boolean::New(env, true);
}

Napi::Value Detach(const Napi::CallbackInfo &info) {
  if (NSThread.isMainThread) {
    DetachOnMain();
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{ DetachOnMain(); });
  }
  return info.Env().Undefined();
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("mount", Napi::Function::New(env, Mount));
  exports.Set("resize", Napi::Function::New(env, Resize));
  exports.Set("viewHandle", Napi::Function::New(env, ViewHandle));
  exports.Set("setVisible", Napi::Function::New(env, SetVisible));
  exports.Set("present", Napi::Function::New(env, Present));
  exports.Set("detach", Napi::Function::New(env, Detach));
  return exports;
}

}  // namespace

NODE_API_MODULE(kente_mac_player, Initialize)
