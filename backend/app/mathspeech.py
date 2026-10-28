"""Spoken math. A dictated transcript that looks like math is split into text and
LaTeX formulas, and a formula can be rewritten from a spoken correction.

Both calls are side calls to Haiku with one forced tool. Nothing here is stored and
no tool rows enter the tree. The model only names the math spans and their LaTeX;
the text around them is cut from the original transcript, so ordinary words are
never rewritten. Any failure in the split returns the plain transcript.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from app import llm
from app.config import get_settings
from app.llm import LLMError

logger = logging.getLogger("tangents")

MATH_MODEL = "claude-haiku-4-5"
MATH_MAX_TOKENS = 1024
MATH_TIMEOUT_SECONDS = 20
LATEX_MAX_CHARS = 1000
TRANSCRIPT_MAX_CHARS = 4000

MATH_INSTRUCTION = (
    "You convert dictated speech into LaTeX. The user spoke into a microphone, and the "
    "transcript may contain mathematics said out loud.\n\n"
    "Call emit_formulas with every span of the transcript that is mathematics, in the order "
    "they appear:\n"
    "- spoken: the words of that span, copied from the transcript.\n"
    "- latex: the formula in LaTeX that KaTeX can render, without $ delimiters.\n\n"
    "Math means expressions, equations, inequalities, and named formulas or theorems the "
    'speaker refers to ("the quadratic formula", "the backpropagation formula"); for a named '
    "formula, write its standard form. Ordinary words around the math are not part of a span, "
    'and neither are numbers used in everyday speech ("I have 3 questions", "at 5 pm").\n\n'
    "Write the formula the speaker meant, not a result: do not simplify, solve, or evaluate. "
    'Use digits for numbers and standard notation. "x square" means x^2. When grouping is '
    "ambiguous, choose what the speaker most likely meant; a trailing \"divided by\" or "
    '"over" after an expression of several terms divides the whole expression. If there is '
    "no math, call emit_formulas with an empty list."
)

EDIT_INSTRUCTION = (
    "You update a LaTeX formula from a spoken correction. The user is looking at the current "
    "formula and said something about it.\n"
    'If the speech describes a change ("only the 6 is over 3", "change x to y", "square the '
    'whole thing"), apply only that change. If the speech is a whole formula said again, '
    "write that formula.\n"
    "Call emit_latex with the complete updated formula in LaTeX that KaTeX can render, "
    "without $ delimiters. Do not simplify, solve, or evaluate."
)

EMIT_FORMULAS = {
    "name": "emit_formulas",
    "description": "Report the math spans found in the transcript, in order.",
    "input_schema": {
        "type": "object",
        "properties": {
            "formulas": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "spoken": {"type": "string"},
                        "latex": {"type": "string"},
                    },
                    "required": ["spoken", "latex"],
                },
            }
        },
        "required": ["formulas"],
    },
}

EMIT_LATEX = {
    "name": "emit_latex",
    "description": "Report the updated formula.",
    "input_schema": {
        "type": "object",
        "properties": {"latex": {"type": "string"}},
        "required": ["latex"],
    },
}

_NUMBER_WORDS = (
    "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|"
    "fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|"
    "eighty|ninety|hundred|thousand|million|half|third|quarter"
)
_GREEK = (
    "alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|"
    "sigma|tau|upsilon|phi|chi|psi|omega"
)
_MATH_WORDS = (
    r"plus|minus|times|multiplied by|divided by|equals?|squared|cubed|to the power|"
    r"square root|cube root|root of|factorial|greater than|less than|integral|integrate|"
    r"derivative|differentiate|d by d|partial|gradient|sum of|summation|product of|limit|"
    r"log|logarithm|ln|sine|cosine|tangent|sin|cos|tan|matrix|matrices|vector|transpose|"
    r"inverse|infinity|subscript|superscript|exponent|modulo|formula|formulas|formulae|"
    r"equation|equations|fraction|" + _GREEK
)
_MATH_PATTERNS = [
    re.compile(rf"\b(?:{_MATH_WORDS})\b", re.IGNORECASE),
    # 4x, 2y, 10n
    re.compile(r"\b\d+\s?[a-z]\b", re.IGNORECASE),
    # x2, a1
    re.compile(r"\b[a-z]\d+\b", re.IGNORECASE),
    # 2 + 3, 6/3, x = 4, a^2. A bare hyphen or slash between words ("well-known",
    # "and/or") is not math, so those two need digits or spaces on both sides.
    re.compile(r"\d\s*[-+*/^=<>]\s*\d"),
    re.compile(r"[\w)]\s*[+*^=<>]\s*[\w(]"),
    re.compile(r"\w\s+[-/]\s+\w"),
    # lone variables
    re.compile(r"\b[xyz]\b", re.IGNORECASE),
    # "x over 2", "3 over n", "five over six"
    re.compile(rf"(?:\b\d+|\b[a-z]|\b(?:{_NUMBER_WORDS}))\s+over\b", re.IGNORECASE),
    re.compile(rf"\bover\s+(?:\d+|[a-z]\b|(?:{_NUMBER_WORDS})\b)", re.IGNORECASE),
    # "e to the i pi", "2 to the 10th"
    re.compile(r"(?:\b\d+|\b[a-z])\s+to the\b", re.IGNORECASE),
]


def looks_like_math(text: str) -> bool:
    """Cheap gate before any model call. Leans toward yes: a false positive costs one
    Haiku call that finds nothing; a false negative loses the feature."""
    return any(pattern.search(text) for pattern in _MATH_PATTERNS)


def sanitize_latex(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    latex = raw.strip()
    wrappers = (("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)"), ("$", "$"))
    changed = True
    while changed:
        changed = False
        for left, right in wrappers:
            if len(latex) > len(left) + len(right) and latex.startswith(left) and latex.endswith(right):
                latex = latex[len(left) : -len(right)].strip()
                changed = True
    if not latex or "$" in latex or len(latex) > LATEX_MAX_CHARS:
        return None
    return latex


def _normalize(text: str) -> tuple[str, list[int]]:
    """Letters and digits only, lowercased, with each kept char's offset in `text`."""
    chars: list[str] = []
    offsets: list[int] = []
    for index, original in enumerate(text):
        for ch in original.lower():
            if ch.isalnum():
                chars.append(ch)
                offsets.append(index)
    return "".join(chars), offsets


def _find_span(
    transcript: str,
    normalized: str,
    offsets: list[int],
    spoken: str,
    start_at: int,
) -> tuple[int, int, int] | None:
    """Locate `spoken` ignoring case, spacing, and punctuation. Returns the original
    [start, end) span and the normalized index to continue from. A match must start
    and end on word boundaries in the original, so "x" never matches inside "next"."""
    needle, _ = _normalize(spoken)
    if not needle:
        return None
    position = normalized.find(needle, start_at)
    while position != -1:
        start = offsets[position]
        end = offsets[position + len(needle) - 1] + 1
        before = transcript[start - 1] if start > 0 else " "
        after = transcript[end] if end < len(transcript) else " "
        if not before.isalnum() and not after.isalnum():
            return start, end, position + len(needle)
        position = normalized.find(needle, position + 1)
    return None


def build_parts(transcript: str, formulas: list[dict[str, str]]) -> list[dict[str, str]]:
    """Cut the transcript around each located formula. Unlocatable formulas are dropped."""
    normalized, offsets = _normalize(transcript)
    parts: list[dict[str, str]] = []
    cursor = 0
    search_from = 0
    for formula in formulas:
        found = _find_span(transcript, normalized, offsets, formula["spoken"], search_from)
        if found is None:
            logger.info("math span not found in transcript: %r", formula["spoken"][:80])
            continue
        start, end, search_from = found
        if start < cursor:
            continue
        if start > cursor:
            parts.append({"type": "text", "text": transcript[cursor:start]})
        parts.append({"type": "formula", "latex": formula["latex"], "spoken": transcript[start:end]})
        cursor = end
    if cursor < len(transcript):
        parts.append({"type": "text", "text": transcript[cursor:]})
    return parts or [{"type": "text", "text": transcript}]


def _call_tool(instruction: str, content: str, tool: dict[str, Any]) -> dict[str, Any]:
    llm.require_config()
    try:
        response = (
            llm._client()
            .with_options(timeout=MATH_TIMEOUT_SECONDS, max_retries=1)
            .messages.create(
                model=MATH_MODEL,
                max_tokens=MATH_MAX_TOKENS,
                system=instruction,
                tools=[tool],
                tool_choice={"type": "tool", "name": tool["name"]},
                messages=[{"role": "user", "content": content}],
            )
        )
    except LLMError:
        raise
    except Exception as exc:
        raise LLMError(str(exc)) from exc

    if getattr(response, "stop_reason", None) == "max_tokens":
        raise LLMError(f"{tool['name']} was cut off")
    for block in response.content:
        dumped = llm._dump_block(block)
        if dumped.get("type") == "tool_use" and dumped.get("name") == tool["name"]:
            payload = dumped.get("input")
            if isinstance(payload, dict):
                return payload
    raise LLMError(f"{tool['name']} was not called")


def _plain(transcript: str) -> list[dict[str, str]]:
    return [{"type": "text", "text": transcript}]


def parse_spoken_math(transcript: str) -> list[dict[str, str]]:
    """Split a transcript into text and formula parts. Never raises."""
    if not transcript.strip() or not looks_like_math(transcript):
        return _plain(transcript)
    if not get_settings().api_key:
        return _plain(transcript)
    try:
        payload = _call_tool(MATH_INSTRUCTION, f"Transcript:\n{transcript}", EMIT_FORMULAS)
    except LLMError as exc:
        logger.warning("math split failed: %s", exc)
        return _plain(transcript)
    raw = payload.get("formulas")
    if not isinstance(raw, list):
        logger.warning("math split returned no formula list")
        return _plain(transcript)
    formulas = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("spoken"), str):
            continue
        latex = sanitize_latex(item.get("latex"))
        if latex is not None and item["spoken"].strip():
            formulas.append({"spoken": item["spoken"], "latex": latex})
    if not formulas:
        return _plain(transcript)
    return build_parts(transcript, formulas)


def edit_formula(latex: str, spoken: str) -> str:
    """Apply a spoken correction to a formula. Raises LLMError on any failure."""
    payload = _call_tool(
        EDIT_INSTRUCTION,
        f"Current formula:\n{latex}\n\nWhat the user said:\n{spoken}",
        EMIT_LATEX,
    )
    updated = sanitize_latex(payload.get("latex"))
    if updated is None:
        raise LLMError("emit_latex returned no usable formula")
    return updated
