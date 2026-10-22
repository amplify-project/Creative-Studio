import { describe, expect, it } from "vitest";
import {
  defaultVideoPrefs,
  extraCameraPrefs,
  isAppleMobile,
  isMobileDevice,
  resolveCodec,
  sanitizeVideoPrefs,
  simulcastLayers,
  topLayerBitrate,
  videoCaptureOptions,
  videoPublishOptions,
  type DeviceEnv,
} from "../../app/utils/videoPublish";

const IPHONE: DeviceEnv = {
  ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  platform: "iPhone",
  maxTouchPoints: 5,
};
const IPADOS: DeviceEnv = {
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  platform: "MacIntel",
  maxTouchPoints: 5,
};
const MAC: DeviceEnv = { ...IPADOS, maxTouchPoints: 0 };
const ANDROID: DeviceEnv = {
  ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
};
const LINUX: DeviceEnv = { ua: "Mozilla/5.0 (X11; Linux x86_64) Chrome/129.0", platform: "Linux x86_64", maxTouchPoints: 0 };

describe("device detection", () => {
  it("treats iPhone and iPadOS-as-Mac as Apple mobile, a real Mac not", () => {
    expect(isAppleMobile(IPHONE)).toBe(true);
    expect(isAppleMobile(IPADOS)).toBe(true);
    expect(isAppleMobile(MAC)).toBe(false);
  });
  it("treats Android as mobile and desktop Linux not", () => {
    expect(isMobileDevice(ANDROID)).toBe(true);
    expect(isMobileDevice(LINUX)).toBe(false);
  });
});

describe("codec", () => {
  it("auto picks H.264 on iOS only", () => {
    expect(resolveCodec("auto", IPHONE)).toBe("h264");
    expect(resolveCodec("auto", IPADOS)).toBe("h264");
    expect(resolveCodec("auto", ANDROID)).toBe("vp8");
    expect(resolveCodec("auto", LINUX)).toBe("vp8");
  });
  it("an explicit choice wins", () => {
    expect(resolveCodec("vp8", IPHONE)).toBe("vp8");
    expect(resolveCodec("h264", LINUX)).toBe("h264");
  });
});

describe("encoding", () => {
  it("phones default to 540p and desktops to 720p, both 24 fps maintain-framerate", () => {
    expect(defaultVideoPrefs(IPHONE)).toMatchObject({ width: 960, height: 540, frameRate: 24, degradationPreference: "maintain-framerate" });
    expect(defaultVideoPrefs(LINUX)).toMatchObject({ width: 1280, height: 720, frameRate: 24 });
  });

  it("gives the extra-camera page well above LiveKit's 500 kbps default", () => {
    const p = extraCameraPrefs();
    const b = topLayerBitrate(p.width, p.height, p.frameRate);
    expect(b).toBeGreaterThanOrEqual(1_500_000);
    expect(b).toBeLessThanOrEqual(2_500_000);
  });

  it("clamps the bitrate", () => {
    expect(topLayerBitrate(3840, 2160, 60)).toBe(2_500_000);
    expect(topLayerBitrate(160, 120, 5)).toBe(100_000);
  });

  it("phones send one extra layer, desktops two, all smaller than the top", () => {
    const phone = simulcastLayers(defaultVideoPrefs(IPHONE), true);
    const desk = simulcastLayers(defaultVideoPrefs(LINUX), false);
    expect(phone.map((l) => l.height)).toEqual([180]);
    expect(desk.map((l) => l.height)).toEqual([360, 180]);
  });

  it("publish options carry codec, fps cap and degradation preference", () => {
    const o = videoPublishOptions(defaultVideoPrefs(IPHONE), "camera", IPHONE);
    expect(o.name).toBe("camera");
    expect(o.videoCodec).toBe("h264");
    expect(o.videoEncoding?.maxFramerate).toBe(24);
    expect(o.degradationPreference).toBe("maintain-framerate");
  });

  it("capture options pass the frame rate, and deviceId over facingMode", () => {
    const p = defaultVideoPrefs(LINUX);
    expect(videoCaptureOptions(p).resolution).toEqual({ width: 1280, height: 720, frameRate: 24 });
    const c = videoCaptureOptions(p, { deviceId: "abc", facingMode: "user" });
    expect(c.deviceId).toBe("abc");
    expect(c.facingMode).toBeUndefined();
  });
});

describe("stored prefs", () => {
  it("falls back field by field on garbage", () => {
    const base = defaultVideoPrefs(LINUX);
    expect(sanitizeVideoPrefs({ width: "x", frameRate: 30, codec: "av1" }, base))
      .toEqual({ ...base, frameRate: 30 });
    expect(sanitizeVideoPrefs(null, base)).toEqual(base);
  });
});
