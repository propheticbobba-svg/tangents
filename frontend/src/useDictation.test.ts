import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDictation } from "./useDictation";

const api = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock("./api", () => api);

class FakeAudioContext {
  sampleRate = 16000;
  state = "running";
  destination = {};
  processor: { onaudioprocess: ((event: unknown) => void) | null } | null = null;
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createScriptProcessor() {
    this.processor = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() } as never;
    return this.processor;
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

let contexts: FakeAudioContext[] = [];
const stop = vi.fn();

beforeEach(() => {
  contexts = [];
  stop.mockReset();
  api.transcribe.mockReset();
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      const context = new FakeAudioContext();
      contexts.push(context);
      return context;
    }),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [{ stop }] })) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Feeds one loud buffer so the speech check passes. */
function speak() {
  const samples = new Float32Array(16000).fill(0.5);
  contexts[0]?.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
}

describe("useDictation", () => {
  it("transcribes, runs process, and delivers the result", async () => {
    api.transcribe.mockResolvedValue({ text: "x plus 1" });
    const process = vi.fn(async (text: string) => `processed:${text}`);
    const onResult = vi.fn();
    const onPhase = vi.fn();
    const { result } = renderHook(() =>
      useDictation({ disabled: false, process, onResult, onError: vi.fn(), onPhase }),
    );
    await act(async () => result.current.toggle());
    expect(result.current.phase).toBe("listening");
    speak();
    await act(async () => result.current.toggle());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith("processed:x plus 1"));
    expect(process).toHaveBeenCalledWith("x plus 1");
    expect(result.current.phase).toBe("idle");
    expect(onPhase.mock.calls.map((call) => call[0])).toEqual(["listening", "transcribing", "idle"]);
    expect(stop).toHaveBeenCalled();
  });

  it("discards the recording when disabled turns on while listening", async () => {
    const onResult = vi.fn();
    const { result, rerender } = renderHook(
      ({ disabled }) => useDictation({ disabled, process: async (t: string) => t, onResult, onError: vi.fn() }),
      { initialProps: { disabled: false } },
    );
    await act(async () => result.current.toggle());
    expect(result.current.phase).toBe("listening");
    await act(async () => rerender({ disabled: true }));
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(api.transcribe).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("reports a failed process on the error line", async () => {
    api.transcribe.mockResolvedValue({ text: "make it y" });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDictation({
        disabled: false,
        process: () => Promise.reject(new Error("Could not update that formula")),
        onResult: vi.fn(),
        onError,
      }),
    );
    await act(async () => result.current.toggle());
    speak();
    await act(async () => result.current.toggle());
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not update that formula"));
  });

  it("delivers nothing after unmount but still reports idle", async () => {
    let resolve: (value: { text: string }) => void = () => {};
    api.transcribe.mockReturnValue(new Promise((r) => (resolve = r)));
    const onResult = vi.fn();
    const onPhase = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDictation({ disabled: false, process: async (t: string) => t, onResult, onError: vi.fn(), onPhase }),
    );
    await act(async () => result.current.toggle());
    speak();
    await act(async () => result.current.toggle());
    unmount();
    await act(async () => resolve({ text: "late" }));
    expect(onResult).not.toHaveBeenCalled();
    expect(onPhase).toHaveBeenLastCalledWith("idle");
  });
});
