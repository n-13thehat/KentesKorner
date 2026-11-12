#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <AudioToolbox/AudioToolbox.h>
#include <dlfcn.h>
#include <node_api.h>
#include <napi.h>
#include <libretro.h>
#include <pthread.h>
#include <pthread/qos.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <memory>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

namespace {

constexpr size_t kAudioCapacity = 1u << 13;
constexpr size_t kAudioQueueFrames = 512;
struct AudioState {
  AudioQueueRef queue = nullptr;
  std::array<float, kAudioCapacity * 2> samples{};
  std::atomic<uint64_t> read{0}, write{0};
  std::atomic<uint64_t> queuedFrames{0};
} g_audio;

std::mutex g_mutex;
std::mutex g_audioMutex;
std::mutex g_audioCallbackMutex;
std::mutex g_diskMutex;
__strong NSView *g_hostView = nil;
__strong NSView *g_playerView = nil;
std::shared_ptr<CGImageRef> g_pendingFrame;
bool g_frameDispatchPending = false;
std::atomic<bool> g_running{false}, g_paused{false}, g_stop{false};
std::atomic<uint64_t> g_videoFrames{0};
std::atomic<uint16_t> g_buttons{0};
std::atomic<retro_pixel_format> g_pixelFormat{RETRO_PIXEL_FORMAT_0RGB1555};
std::atomic<int16_t> g_axes[4]{};
std::atomic<double> g_frameRate{60.0}, g_sampleRate{48000.0};
std::thread g_emulationThread;
std::string g_error;
std::string g_systemDir, g_saveDir;
std::map<std::string, std::string> g_coreOptions;
retro_disk_control_ext_callback g_diskControl{};
std::atomic<unsigned> g_discCount{0}, g_discIndex{0};
void *g_core = nullptr;

std::string PreferredCoreOption(const std::string &key, std::string selected) {
#if defined(__APPLE__)
  // Kente does not provide a libretro Vulkan hardware context. PCEE2's
  // native Metal renderer owns its Metal device and uses the core's supported
  // readback path to return frames to Kente's AppKit surface.
  if (key == "pcsx2_renderer") return "metal";
#endif
  return selected;
}

using SetEnv = decltype(&retro_set_environment);
using SetVideo = decltype(&retro_set_video_refresh);
using SetAudio = decltype(&retro_set_audio_sample);
using SetAudioBatch = decltype(&retro_set_audio_sample_batch);
using SetInputPoll = decltype(&retro_set_input_poll);
using SetInputState = decltype(&retro_set_input_state);
using VoidFn = decltype(&retro_init);
using LoadGame = decltype(&retro_load_game);
using RunFn = decltype(&retro_run);
using UnloadGame = decltype(&retro_unload_game);
using DeinitFn = decltype(&retro_deinit);
using GetAvInfo = decltype(&retro_get_system_av_info);

SetEnv p_set_environment = nullptr;
SetVideo p_set_video = nullptr;
SetAudio p_set_audio = nullptr;
SetAudioBatch p_set_audio_batch = nullptr;
SetInputPoll p_set_input_poll = nullptr;
SetInputState p_set_input_state = nullptr;
VoidFn p_init = nullptr, p_deinit = nullptr;
LoadGame p_load_game = nullptr;
RunFn p_run = nullptr;
UnloadGame p_unload_game = nullptr;
GetAvInfo p_get_av_info = nullptr;
retro_audio_buffer_status_callback_t g_audioStatusCallback = nullptr;
std::atomic<bool> g_audioActive{false};

void CoreLog(retro_log_level level, const char *format, ...);

bool ReadText(Napi::Object obj, const char *key, std::string *out) {
  Napi::Value value = obj.Get(key);
  if (!value.IsString()) return false;
  *out = value.As<Napi::String>().Utf8Value();
  return !out->empty();
}

void SetError(const std::string &message) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_error = message;
}

void PresentOnMain() {
  std::shared_ptr<CGImageRef> frame;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    frame = std::move(g_pendingFrame);
    g_frameDispatchPending = false;
  }
  if (frame && g_playerView) {
    g_playerView.layer.contents = (__bridge id)*frame;
    if (!g_paused.load(std::memory_order_acquire)) g_playerView.hidden = NO;
  }
}

bool QueueOwnedRGBAFrame(uint8_t *pixels, unsigned width, unsigned height) {
  if (!pixels || !width || !height || width > 8192 || height > 8192) {
    std::free(pixels);
    return false;
  }
  const size_t length = static_cast<size_t>(width) * height * 4;
  CGDataProviderRef provider = CGDataProviderCreateWithData(nullptr, pixels, length,
    [](void *, const void *bytes, size_t) { std::free(const_cast<void *>(bytes)); });
  if (!provider) { std::free(pixels); return false; }
  CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
  CGImageRef image = CGImageCreate(width, height, 8, 32,
      width * 4, color, kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast, provider, nullptr, false,
      kCGRenderingIntentDefault);
  CGColorSpaceRelease(color);
  CGDataProviderRelease(provider);
  if (!image) return false;
  auto holder = std::shared_ptr<CGImageRef>(new CGImageRef(image), [](CGImageRef *p) {
    if (*p) CGImageRelease(*p);
    delete p;
  });
  bool schedule = false;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_pendingFrame = std::move(holder);
    if (!g_frameDispatchPending) { g_frameDispatchPending = true; schedule = true; }
  }
  if (schedule) dispatch_async(dispatch_get_main_queue(), ^{ PresentOnMain(); });
  return true;
}

void VideoRefresh(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data) return;
  const auto format = g_pixelFormat.load(std::memory_order_relaxed);
  if (!width || !height || width > 8192 || height > 8192) return;
  const size_t sourceBpp = format == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
  if (pitch < static_cast<size_t>(width) * sourceBpp) return;
  auto *rgba = static_cast<uint8_t *>(std::malloc(static_cast<size_t>(width) * height * 4));
  if (!rgba) return;
  if (format == RETRO_PIXEL_FORMAT_XRGB8888) {
    // Convert native 0xAARRGGBB words into tightly packed RGBA for CoreGraphics.
    const auto *src = static_cast<const uint8_t *>(data);
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
      uint32_t pixel;
      std::memcpy(&pixel, src + static_cast<size_t>(y) * pitch + x * 4, 4);
      size_t o = (static_cast<size_t>(y) * width + x) * 4;
      rgba[o] = (pixel >> 16) & 0xff; rgba[o + 1] = (pixel >> 8) & 0xff;
      rgba[o + 2] = pixel & 0xff; rgba[o + 3] = 0xff;
    }
  } else {
    const auto *src = static_cast<const uint16_t *>(data);
    const bool rgb565 = format == RETRO_PIXEL_FORMAT_RGB565;
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
      uint16_t pixel;
      std::memcpy(&pixel, reinterpret_cast<const uint8_t *>(src) + static_cast<size_t>(y) * pitch + x * 2, 2);
      uint8_t r = rgb565 ? ((pixel >> 11) & 31) : ((pixel >> 10) & 31);
      uint8_t g = rgb565 ? ((pixel >> 5) & 63) : ((pixel >> 5) & 31);
      uint8_t b = pixel & 31;
      size_t o = (static_cast<size_t>(y) * width + x) * 4;
      rgba[o] = (r << 3) | (r >> 2);
      rgba[o + 1] = rgb565 ? (g << 2) | (g >> 4) : (g << 3) | (g >> 2);
      rgba[o + 2] = (b << 3) | (b >> 2); rgba[o + 3] = 0xff;
    }
  }
  if (QueueOwnedRGBAFrame(rgba, width, height))
    g_videoFrames.fetch_add(1, std::memory_order_release);
}

bool QueueAudioSample(int16_t left, int16_t right) {
  const uint64_t write = g_audio.write.load(std::memory_order_relaxed);
  const uint64_t read = g_audio.read.load(std::memory_order_acquire);
  if (write - read >= kAudioCapacity) return false;
  const size_t slot = (write % kAudioCapacity) * 2;
  g_audio.samples[slot] = static_cast<float>(left) / 32768.0f;
  g_audio.samples[slot + 1] = static_cast<float>(right) / 32768.0f;
  g_audio.write.store(write + 1, std::memory_order_release);
  return true;
}

void AudioSample(int16_t left, int16_t right) {
  QueueAudioSample(left, right);
}

size_t AudioBatch(const int16_t *data, size_t frames) {
  if (!data) return 0;
  size_t accepted = 0;
  for (; accepted < frames; ++accepted)
    if (!QueueAudioSample(data[accepted * 2], data[accepted * 2 + 1])) break;
  return accepted;
}

void FillAudioQueueBuffer(AudioQueueRef queue, AudioQueueBufferRef buffer) {
  auto *out = static_cast<int16_t *>(buffer->mAudioData);
  constexpr size_t frames = kAudioQueueFrames;
  for (size_t i = 0; i < frames; ++i) {
    const uint64_t read = g_audio.read.load(std::memory_order_relaxed);
    const uint64_t write = g_audio.write.load(std::memory_order_acquire);
    if (read < write) {
      const size_t slot = (read % kAudioCapacity) * 2;
      out[i * 2] = static_cast<int16_t>(std::clamp(g_audio.samples[slot] * 32767.0f, -32768.0f, 32767.0f));
      out[i * 2 + 1] = static_cast<int16_t>(std::clamp(g_audio.samples[slot + 1] * 32767.0f, -32768.0f, 32767.0f));
      g_audio.read.store(read + 1, std::memory_order_release);
    } else {
      out[i * 2] = out[i * 2 + 1] = 0;
    }
  }
  buffer->mAudioDataByteSize = static_cast<UInt32>(frames * 2 * sizeof(int16_t));
  g_audio.queuedFrames.fetch_add(frames, std::memory_order_acq_rel);
  AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr);
}

void AudioQueueOutput(void *user, AudioQueueRef queue, AudioQueueBufferRef buffer) {
  (void)user;
  std::lock_guard<std::mutex> lock(g_audioCallbackMutex);
  if (!g_audioActive.load(std::memory_order_acquire)) return;
  g_audio.queuedFrames.fetch_sub(buffer->mAudioDataByteSize / 4, std::memory_order_acq_rel);
  FillAudioQueueBuffer(queue, buffer);
}

bool StartAudio(double sampleRate) {
  std::lock_guard<std::mutex> lock(g_audioMutex);
  // Samples queued at the previous rate cannot be played after a rate change.
  g_audio.read.store(g_audio.write.load(std::memory_order_acquire), std::memory_order_release);
  AudioStreamBasicDescription format{};
  format.mSampleRate = sampleRate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
  format.mBytesPerPacket = 4;
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = 4;
  format.mChannelsPerFrame = 2;
  format.mBitsPerChannel = 16;
  g_audio.queuedFrames.store(0, std::memory_order_release);
  if (AudioQueueNewOutput(&format, AudioQueueOutput, nullptr, nullptr, nullptr, 0,
                          &g_audio.queue) != noErr) return false;
  unsigned allocated = 0;
  for (int i = 0; i < 3; ++i) {
    AudioQueueBufferRef buffer = nullptr;
    if (AudioQueueAllocateBuffer(g_audio.queue, kAudioQueueFrames * 4, &buffer) != noErr) break;
    ++allocated;
    FillAudioQueueBuffer(g_audio.queue, buffer);
  }
  if (allocated != 3) {
    AudioQueueDispose(g_audio.queue, true);
    g_audio.queue = nullptr;
    return false;
  }
  g_audioActive.store(true, std::memory_order_release);
  // A core may renegotiate its sample rate while the HUD pause menu is open.
  // Rebuild the queue without restarting playback until the user resumes.
  if (!g_paused.load(std::memory_order_acquire)
      && AudioQueueStart(g_audio.queue, nullptr) != noErr) {
    g_audioActive.store(false, std::memory_order_release);
    // AudioQueueStart may have scheduled an output callback before reporting
    // failure. Drain it before flushing and disposing the partially started
    // queue, just as the normal stop path does.
    {
      std::lock_guard<std::mutex> callbackLock(g_audioCallbackMutex);
    }
    AudioQueueStop(g_audio.queue, true);
    AudioQueueDispose(g_audio.queue, true);
    g_audio.queue = nullptr;
    return false;
  }
  return true;
}

void StopAudio() {
  std::lock_guard<std::mutex> lock(g_audioMutex);
  g_audioActive.store(false, std::memory_order_release);
  // Drain any callback that started before the stop flag. Later callbacks see
  // inactive and return without enqueuing, so AudioQueueStop can flush cleanly.
  {
    std::lock_guard<std::mutex> callbackLock(g_audioCallbackMutex);
  }
  if (!g_audio.queue) {
    g_audio.read = g_audio.write.load(std::memory_order_acquire);
    g_audio.queuedFrames.store(0, std::memory_order_release);
    return;
  }
  AudioQueueStop(g_audio.queue, true);
  AudioQueueDispose(g_audio.queue, true);
  g_audio.queue = nullptr;
  g_audio.read = g_audio.write.load(std::memory_order_acquire);
  g_audio.queuedFrames.store(0, std::memory_order_release);
}

bool Environment(unsigned command, void *data) {
  const auto registerOptions = [](retro_core_option_v2_definition *definitions) {
    if (!definitions) return false;
    for (auto *option = definitions; option->key; ++option) {
      std::string key = option->key;
      std::string selected = option->default_value ? option->default_value : "";
      if (!selected.empty()) g_coreOptions[key] = PreferredCoreOption(key, std::move(selected));
    }
    return true;
  };
  switch (command) {
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
      *static_cast<bool *>(data) = true; return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
    case RETRO_ENVIRONMENT_SHUTDOWN:
      g_stop = true; return true;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      *static_cast<const char **>(data) = g_systemDir.c_str(); return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
      *static_cast<const char **>(data) = g_saveDir.c_str(); return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
      auto format = *static_cast<retro_pixel_format *>(data);
      if (format != RETRO_PIXEL_FORMAT_0RGB1555
          && format != RETRO_PIXEL_FORMAT_XRGB8888
          && format != RETRO_PIXEL_FORMAT_RGB565) return false;
      g_pixelFormat = format;
      return true;
    }
    case RETRO_ENVIRONMENT_SET_HW_RENDER:
      // A generic libretro HW context is not available from this NSView host.
      // Cores must fall back to CPU-frame readback when negotiation is refused.
      return false;
    case RETRO_ENVIRONMENT_SET_VARIABLES:
      if (!data) return false;
      for (auto *option = static_cast<retro_variable *>(data); option->key; ++option) {
        std::string definition = option->value ? option->value : "";
        const auto divider = definition.find(';');
        std::string selected = divider == std::string::npos ? definition : definition.substr(divider + 1);
        const auto nextChoice = selected.find('|');
        if (nextChoice != std::string::npos) selected.resize(nextChoice);
        while (!selected.empty() && std::isspace(static_cast<unsigned char>(selected.front()))) selected.erase(selected.begin());
        while (!selected.empty() && std::isspace(static_cast<unsigned char>(selected.back()))) selected.pop_back();
        std::string key = option->key;
        g_coreOptions[key] = PreferredCoreOption(key, std::move(selected));
      }
      return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
      return data && registerOptions(static_cast<retro_core_options_v2 *>(data)->definitions);
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL: {
      if (!data) return false;
      auto *options = static_cast<retro_core_options_v2_intl *>(data);
      return options->us && registerOptions(options->us->definitions);
    }
    case RETRO_ENVIRONMENT_SET_AUDIO_BUFFER_STATUS_CALLBACK:
      if (!data) return false;
      g_audioStatusCallback = static_cast<retro_audio_buffer_status_callback *>(data)->callback;
      return true;
    case RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE: {
      if (!data) return false;
      const auto *callbacks = static_cast<const retro_disk_control_ext_callback *>(data);
      if (!callbacks->set_eject_state || !callbacks->get_eject_state
          || !callbacks->get_image_index || !callbacks->set_image_index
          || !callbacks->get_num_images) return false;
      std::lock_guard<std::mutex> lock(g_diskMutex);
      g_diskControl = *callbacks;
      return true;
    }
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
      if (!data) return false;
      const auto *av = static_cast<const retro_system_av_info *>(data);
      const double fps = av->timing.fps;
      const double sampleRate = av->timing.sample_rate;
      if (!std::isfinite(fps) || fps < 20.0 || fps > 240.0
          || !std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0)
        return false;
      g_frameRate.store(fps, std::memory_order_release);
      const double previousSampleRate = g_sampleRate.exchange(sampleRate, std::memory_order_acq_rel);
      if (std::abs(previousSampleRate - sampleRate) > 0.5
          && g_audioActive.load(std::memory_order_acquire)) {
        StopAudio();
        if (!StartAudio(sampleRate)) {
          SetError("Kente could not update macOS audio for the game's sample rate.");
          g_stop.store(true, std::memory_order_release);
          return false;
        }
      }
      return true;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      auto *variable = static_cast<retro_variable *>(data);
      if (variable) {
        auto found = g_coreOptions.find(variable->key ? variable->key : "");
        variable->value = found == g_coreOptions.end() ? nullptr : found->second.c_str();
      }
      return variable != nullptr;
    }
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
      if (!data) return false;
      *static_cast<unsigned *>(data) = 2; return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      *static_cast<bool *>(data) = false; return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      if (!data) return false;
      static_cast<retro_log_callback *>(data)->log = CoreLog;
      return true;
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
      return true;
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_MESSAGE:
    case RETRO_ENVIRONMENT_SET_MESSAGE_EXT:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
      return true;
    default:
      return false;
  }
}

void InputPoll() {}
int16_t InputState(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port != 0) return 0;
  if ((device & RETRO_DEVICE_MASK) == RETRO_DEVICE_JOYPAD) {
    const auto buttons = g_buttons.load(std::memory_order_relaxed);
    if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return static_cast<int16_t>(buttons);
    if (id >= 16) return 0;
    return (buttons & (1u << id)) ? 1 : 0;
  }
  if ((device & RETRO_DEVICE_MASK) == RETRO_DEVICE_ANALOG && index < 2 && id < 2)
    return g_axes[index * 2 + id].load(std::memory_order_relaxed);
  return 0;
}

void CoreLog(retro_log_level level, const char *format, ...) {
  static const char *labels[] = {"debug", "info", "warn", "error"};
  const unsigned index = static_cast<unsigned>(level);
  std::fprintf(stderr, "[PCEE2:%s] ", index < 4 ? labels[index] : "log");
  va_list args;
  va_start(args, format);
  std::vfprintf(stderr, format, args);
  va_end(args);
}

template <typename T> bool LoadSymbol(const char *name, T *out) {
  *out = reinterpret_cast<T>(dlsym(g_core, name));
  if (*out) return true;
  SetError(std::string("Core missing required symbol: ") + name);
  return false;
}

Napi::Value ProbeCore(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "probeCore requires a core dylib path").ThrowAsJavaScriptException();
    return env.Null();
  }
  const std::string corePath = info[0].As<Napi::String>().Utf8Value();
  void *core = dlopen(corePath.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!core) {
    const char *error = dlerror();
    Napi::Error::New(env, error ? error : "Could not load the packaged emulator core")
      .ThrowAsJavaScriptException();
    return env.Null();
  }
  const std::string moltenVkPath =
    (std::filesystem::path(corePath).parent_path() / "libMoltenVK.dylib").string();
  void *moltenVk = dlopen(moltenVkPath.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!moltenVk) {
    const char *error = dlerror();
    dlclose(core);
    Napi::Error::New(env, error ? error : "Could not load bundled MoltenVK beside the emulator core")
      .ThrowAsJavaScriptException();
    return env.Null();
  }
  const bool moltenVkReady = dlsym(moltenVk, "vkGetInstanceProcAddr") != nullptr;
  dlclose(moltenVk);
  if (!moltenVkReady) {
    dlclose(core);
    Napi::Error::New(env, "The bundled MoltenVK library does not export vkGetInstanceProcAddr")
      .ThrowAsJavaScriptException();
    return env.Null();
  }
  constexpr std::array<const char *, 12> required = {
    "retro_set_environment", "retro_set_video_refresh", "retro_set_audio_sample",
    "retro_set_audio_sample_batch", "retro_set_input_poll", "retro_set_input_state",
    "retro_init", "retro_deinit", "retro_load_game", "retro_run", "retro_unload_game",
    "retro_get_system_av_info",
  };
  std::string missing;
  for (const char *symbol : required) {
    if (dlsym(core, symbol)) continue;
    if (!missing.empty()) missing += ", ";
    missing += symbol;
  }
  dlclose(core);
  if (!missing.empty()) {
    const std::string message = "The packaged emulator core is missing required libretro symbols: " + missing;
    Napi::Error::New(env, message.c_str()).ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(env, true);
}

void CleanupCore(bool initialized, bool loaded) {
  g_running.store(false, std::memory_order_release);
  {
    std::lock_guard<std::mutex> lock(g_diskMutex);
    g_discCount.store(0, std::memory_order_release);
    g_discIndex.store(0, std::memory_order_release);
    g_diskControl = {};
  }
  if (loaded && p_unload_game) p_unload_game();
  if (initialized && p_deinit) p_deinit();
  StopAudio();
  if (g_core) dlclose(g_core);
  g_core = nullptr;
  g_audioStatusCallback = nullptr;
  g_running = false;
}

void EmulationLoop(std::string corePath, std::string romPath) {
  bool initialized = false, loaded = false;
  pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
  @autoreleasepool {
    g_core = dlopen(corePath.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!g_core) { const char *error = dlerror(); SetError(error ? error : "Could not load emulator core"); g_running = false; return; }
#define LOAD_CORE(symbol, target) if (!LoadSymbol(symbol, &target)) { CleanupCore(false, false); return; }
    LOAD_CORE("retro_set_environment", p_set_environment)
    LOAD_CORE("retro_set_video_refresh", p_set_video)
    LOAD_CORE("retro_set_audio_sample", p_set_audio)
    LOAD_CORE("retro_set_audio_sample_batch", p_set_audio_batch)
    LOAD_CORE("retro_set_input_poll", p_set_input_poll)
    LOAD_CORE("retro_set_input_state", p_set_input_state)
    LOAD_CORE("retro_init", p_init)
    LOAD_CORE("retro_deinit", p_deinit)
    LOAD_CORE("retro_load_game", p_load_game)
    LOAD_CORE("retro_run", p_run)
    LOAD_CORE("retro_unload_game", p_unload_game)
    LOAD_CORE("retro_get_system_av_info", p_get_av_info)
#undef LOAD_CORE
    p_set_environment(Environment);
    p_set_video(VideoRefresh);
    p_set_audio(AudioSample);
    p_set_audio_batch(AudioBatch);
    p_set_input_poll(InputPoll);
    p_set_input_state(InputState);
    p_init(); initialized = true;
    retro_game_info game{};
    game.path = romPath.c_str();
    if (!p_load_game(&game)) {
      SetError("The emulator core rejected this game file.");
      CleanupCore(initialized, false); return;
    }
    loaded = true;
    {
      std::lock_guard<std::mutex> lock(g_diskMutex);
      const unsigned count = g_diskControl.get_num_images ? g_diskControl.get_num_images() : 0;
      const unsigned index = count && g_diskControl.get_image_index
        ? g_diskControl.get_image_index() : 0;
      g_discCount.store(count, std::memory_order_release);
      g_discIndex.store(index, std::memory_order_release);
    }
    retro_system_av_info av{};
    p_get_av_info(&av);
    if (!std::isfinite(av.timing.sample_rate) || av.timing.sample_rate < 8000.0
        || av.timing.sample_rate > 192000.0 || !std::isfinite(av.timing.fps)
        || av.timing.fps < 20.0 || av.timing.fps > 240.0) {
      SetError("The emulator core reported unsupported audio or video timing.");
      CleanupCore(initialized, loaded); return;
    }
    if (g_stop.load(std::memory_order_acquire)) {
      CleanupCore(initialized, loaded); return;
    }
    g_frameRate.store(av.timing.fps, std::memory_order_release);
    g_sampleRate.store(av.timing.sample_rate, std::memory_order_release);
    if (!StartAudio(av.timing.sample_rate)) {
      SetError("Kente could not initialize macOS audio output for this game.");
      CleanupCore(initialized, loaded); return;
    }
    if (g_stop.load(std::memory_order_acquire)) {
      CleanupCore(initialized, loaded); return;
    }
    g_running = true;
    while (!g_stop.load()) {
      if (g_paused.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      if (g_audioStatusCallback) {
        const uint64_t write = g_audio.write.load(std::memory_order_acquire);
        const uint64_t read = g_audio.read.load(std::memory_order_acquire);
        const uint64_t queued = (write >= read ? write - read : 0)
          + g_audio.queuedFrames.load(std::memory_order_acquire);
        const unsigned occupancy = static_cast<unsigned>(std::min<uint64_t>(100, queued * 100 / kAudioCapacity));
        g_audioStatusCallback(g_audioActive.load(std::memory_order_acquire), occupancy, occupancy < 5);
      }
      // PCEE2's retro_run() blocks until its CPU thread finishes the matching
      // emulated frame. Adding a frontend sleep here applies a second frame
      // limiter and cuts gameplay throughput roughly in half.
      p_run();
    }
    CleanupCore(initialized, loaded);
  }
}

Napi::Value Start(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "start requires corePath, gamePath, systemDir and saveDir").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object options = info[0].As<Napi::Object>();
  std::string corePath, gamePath, systemDir, saveDir;
  if (!ReadText(options, "corePath", &corePath) || !ReadText(options, "gamePath", &gamePath)
      || !ReadText(options, "systemDir", &systemDir) || !ReadText(options, "saveDir", &saveDir)) {
    Napi::TypeError::New(env, "native core paths must be non-empty strings").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!std::filesystem::is_regular_file(corePath) || !std::filesystem::is_regular_file(gamePath))
    return Napi::Boolean::New(env, false);
  if (g_running) {
    Napi::Error::New(env, "A Mac native game session is already active").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (g_emulationThread.joinable()) g_emulationThread.join();
  try {
    std::filesystem::create_directories(systemDir);
    std::filesystem::create_directories(saveDir);
  } catch (...) {
    Napi::Error::New(env, "Could not create native emulator data folders").ThrowAsJavaScriptException();
    return env.Null();
  }
  g_systemDir = std::move(systemDir);
  g_saveDir = std::move(saveDir);
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_error.clear();
  }
  g_stop = false; g_paused = false;
  g_videoFrames.store(0, std::memory_order_release);
  {
    std::lock_guard<std::mutex> lock(g_diskMutex);
    g_diskControl = {};
    g_discCount.store(0, std::memory_order_release);
    g_discIndex.store(0, std::memory_order_release);
  }
  g_audio.read = g_audio.write = 0;
  g_running = true;  // Includes core initialization; asynchronous failures clear this.
  try {
    g_emulationThread = std::thread(EmulationLoop, std::move(corePath), std::move(gamePath));
  } catch (const std::exception &error) {
    g_running = false;
    Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo &info) {
  (void)info;
  // Silence the device before waiting for the core thread. A core may still
  // be finishing its current frame, and AudioQueue can otherwise play already
  // queued samples during that teardown window.
  g_stop.store(true, std::memory_order_release);
  StopAudio();
  if (g_emulationThread.joinable()) g_emulationThread.join();
  g_running = false;
  return info.Env().Undefined();
}

Napi::Value SetPaused(const Napi::CallbackInfo &info) {
  if (info.Length() != 1 || !info[0].IsBoolean()) return Napi::Boolean::New(info.Env(), false);
  const bool requested = info[0].As<Napi::Boolean>().Value();
  {
    std::lock_guard<std::mutex> lock(g_audioMutex);
    const bool wasPaused = g_paused.load(std::memory_order_acquire);
    if (requested == wasPaused) return Napi::Boolean::New(info.Env(), true);
    if (!g_audio.queue) {
      g_paused.store(requested, std::memory_order_release);
      return Napi::Boolean::New(info.Env(), true);
    }
    if (requested) {
      if (AudioQueuePause(g_audio.queue) != noErr)
        return Napi::Boolean::New(info.Env(), false);
      g_paused.store(true, std::memory_order_release);
    } else {
      // The user can resume while the core is still initializing. StartAudio
      // may already have created a paused queue before g_running is published.
      if (g_audioActive.load(std::memory_order_acquire)
          && AudioQueueStart(g_audio.queue, nullptr) != noErr)
        return Napi::Boolean::New(info.Env(), false);
      g_paused.store(false, std::memory_order_release);
    }
  }
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value SetInput(const Napi::CallbackInfo &info) {
  if (info.Length() != 2 || !info[0].IsNumber() || !info[1].IsArray())
    return Napi::Boolean::New(info.Env(), false);
  g_buttons = static_cast<uint16_t>(info[0].As<Napi::Number>().Uint32Value() & 0xffff);
  Napi::Array axes = info[1].As<Napi::Array>();
  for (uint32_t i = 0; i < 4; ++i) {
    auto value = axes.Get(i);
    double axis = value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : 0.0;
    axis = std::clamp(axis, -1.0, 1.0);
    g_axes[i] = static_cast<int16_t>(axis * 32767.0);
  }
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value ChangeDisc(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsNumber())
    return Napi::Boolean::New(env, false);
  const int direction = info[0].As<Napi::Number>().Int32Value();
  if (direction != -1 && direction != 1) return Napi::Boolean::New(env, false);
  std::lock_guard<std::mutex> lock(g_diskMutex);
  const unsigned count = g_discCount.load(std::memory_order_acquire);
  if (!g_running.load(std::memory_order_acquire) || g_stop.load(std::memory_order_acquire) || count < 2
      || !g_diskControl.get_eject_state || !g_diskControl.set_eject_state
      || !g_diskControl.get_image_index || !g_diskControl.set_image_index)
    return Napi::Boolean::New(env, false);

  const unsigned current = g_diskControl.get_image_index();
  const unsigned next = direction > 0 ? (current + 1) % count : (current + count - 1) % count;
  const bool wasEjected = g_diskControl.get_eject_state();
  if (!wasEjected && !g_diskControl.set_eject_state(true))
    return Napi::Boolean::New(env, false);
  const bool selected = g_diskControl.set_image_index(next);
  const bool inserted = wasEjected || g_diskControl.set_eject_state(false);
  const unsigned actual = g_diskControl.get_image_index();
  g_discIndex.store(actual, std::memory_order_release);
  return Napi::Boolean::New(env, selected && inserted && actual == next);
}

Napi::Value SetPlayerView(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || (!info[0].IsBuffer() && !info[0].IsNull()))
    return Napi::Boolean::New(env, false);
  NSView *view = nil;
  if (info[0].IsBuffer()) {
    auto handle = info[0].As<Napi::Buffer<uint8_t>>();
    if (handle.Length() != sizeof(void *)) return Napi::Boolean::New(env, false);
    void *raw = nullptr;
    std::memcpy(&raw, handle.Data(), sizeof(raw));
    if (!raw) return Napi::Boolean::New(env, false);
    view = (__bridge NSView *)raw;
  }
  if (!NSThread.isMainThread) {
    dispatch_sync(dispatch_get_main_queue(), ^{ g_playerView = view; });
  } else {
    g_playerView = view;
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value Status(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("running", Napi::Boolean::New(env, g_running.load()));
  out.Set("paused", Napi::Boolean::New(env, g_paused.load()));
  out.Set("videoFrames", Napi::Number::New(env, static_cast<double>(g_videoFrames.load(std::memory_order_acquire))));
  out.Set("discCount", Napi::Number::New(env, g_discCount.load(std::memory_order_acquire)));
  out.Set("discIndex", Napi::Number::New(env, g_discIndex.load(std::memory_order_acquire)));
  { std::lock_guard<std::mutex> lock(g_mutex); out.Set("error", Napi::String::New(env, g_error)); }
  return out;
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("probeCore", Napi::Function::New(env, ProbeCore));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("setPaused", Napi::Function::New(env, SetPaused));
  exports.Set("setInput", Napi::Function::New(env, SetInput));
  exports.Set("changeDisc", Napi::Function::New(env, ChangeDisc));
  exports.Set("setPlayerView", Napi::Function::New(env, SetPlayerView));
  exports.Set("status", Napi::Function::New(env, Status));
  return exports;
}

}  // namespace

NODE_API_MODULE(kente_mac_libretro, Initialize)
