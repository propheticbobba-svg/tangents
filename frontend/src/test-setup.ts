// ProseMirror measures ranges and scrolls the caret into view; jsdom implements neither.
const emptyRect = (): DOMRect => new DOMRect(0, 0, 0, 0);
const emptyRects = (): DOMRectList => {
  const list = [] as unknown as DOMRectList & DOMRect[];
  Object.defineProperty(list, "item", { value: () => null });
  return list;
};

if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = emptyRect;
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRects;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!document.elementFromPoint) document.elementFromPoint = () => null;
