import { describe, expect, it } from "vitest";
import { appendTranscript, concatFloat32, encodeWav, hasSpeech, resample } from "./dictation";

describe("concatFloat32", () => {
  it("joins chunks in order", () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it("returns an empty buffer when there are no chunks", () => {
    expect(concatFloat32([])).toHaveLength(0);
  });
});

describe("resample", () => {
  it("returns the same array when the rates match", () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("interpolates when the rate changes", () => {
    const out = resample(new Float32Array([0, 1]), 2, 4);
    expect(out).toHaveLength(4);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(1);
    expect(out[3]).toBeCloseTo(1);
  });
});

describe("encodeWav", () => {
  it("writes a mono 16-bit PCM header", async () => {
    const blob = encodeWav(new Float32Array([0, 1, -1]), 16000);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(50);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(42);
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32767);
  });
});

describe("hasSpeech", () => {
  it("rejects a clip shorter than 300 ms at 16 kHz", () => {
    const samples = new Float32Array(4799);
    samples[0] = 1;
    expect(hasSpeech(samples)).toBe(false);
  });

  it("rejects a quiet clip", () => {
    expect(hasSpeech(new Float32Array(4800))).toBe(false);
  });

  it("accepts a clip that reaches the peak floor", () => {
    const samples = new Float32Array(4800);
    samples[10] = 0.02;
    expect(hasSpeech(samples)).toBe(true);
  });
});

describe("appendTranscript", () => {
  it("leaves the draft alone when spoken text is empty", () => {
    expect(appendTranscript("hello", "   ")).toBe("hello");
  });

  it("returns spoken text when the draft is empty", () => {
    expect(appendTranscript("", "  hi ")).toBe("hi");
  });

  it("inserts a space when the draft has no trailing whitespace", () => {
    expect(appendTranscript("hello", "there")).toBe("hello there");
  });

  it("keeps existing trailing whitespace", () => {
    expect(appendTranscript("hello ", "there")).toBe("hello there");
    expect(appendTranscript("hello\n", "there")).toBe("hello\nthere");
  });
});
