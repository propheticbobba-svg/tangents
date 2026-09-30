import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

function renderHandle() {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const view = render(<ResizeHandle width={384} onPreview={onPreview} onCommit={onCommit} />);
  const handle = view.getByRole("separator");
  return { ...view, handle, onPreview, onCommit };
}

afterEach(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  cleanup();
});

describe("ResizeHandle", () => {
  it("previews while dragging and commits on pointer up", () => {
    const { handle, onPreview, onCommit } = renderHandle();

    fireEvent.pointerDown(handle, { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });

    expect(onPreview).toHaveBeenCalledWith(484);
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerUp(handle, { clientX: 400, pointerId: 1 });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(484);
    expect(document.body.style.userSelect).toBe("");
  });

  it("clamps a drag to the sidebar and chat minimums", () => {
    const { handle, onPreview } = renderHandle();

    fireEvent.pointerDown(handle, { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -2000, pointerId: 1 });
    expect(onPreview).toHaveBeenLastCalledWith(664);

    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(onPreview).toHaveBeenLastCalledWith(280);
  });

  it("ignores pointer moves that are not a drag", () => {
    const { handle, onPreview } = renderHandle();

    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });

    expect(onPreview).not.toHaveBeenCalled();
  });

  it("resizes from the keyboard and resets on double-click", () => {
    const { handle, onCommit } = renderHandle();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenLastCalledWith(400);

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(448);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onCommit).toHaveBeenLastCalledWith(368);

    fireEvent.doubleClick(handle);
    expect(onCommit).toHaveBeenLastCalledWith(384);
  });

  it("exposes separator attributes", () => {
    const { handle } = renderHandle();

    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("384");
    expect(handle.getAttribute("tabindex")).toBe("0");
  });
});
