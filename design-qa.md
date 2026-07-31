# 弹窗紧凑布局 Design QA

**Source visual truth**

- `artifacts/design-qa/popup-v0.3.1-reference.png`
- 用户批注目标：把三档门槛说明移到右侧，释放下半部分空间并消除弹窗滚动条。

**Implementation evidence**

- Light screenshot: `artifacts/design-qa/popup-v0.3.2-light.png`
- Dark screenshot: `artifacts/design-qa/popup-v0.3.2-dark.png`
- Side-by-side comparison: `artifacts/design-qa/popup-v0.3.2-comparison.png`
- Browser-rendered by `tests/popup-visual-check.mjs`.

**Normalization**

- Source pixels: 340 × 600.
- Implementation pixels: 340 × 600.
- CSS viewport: 340 × 600.
- Device scale factor: 1.
- State: light theme, extension enabled, balanced mode, long-reasoning optimization active, connection healthy, 6 messages and 12 old reasoning segments.
- Both captures use the same crop and contain no surrounding browser chrome.

**Full-view comparison evidence**

- The source requires vertical scrolling and hides the lower action and privacy note.
- The implementation places each mode name on the left and its threshold note on the right in one 38px row.
- Implementation body content is 551px tall inside the 600px viewport. Root scroll size is exactly 340 × 600, so neither axis overflows.
- The complete “暂时显示全部内容” action and privacy note are visible with comfortable bottom space.

**Focused-region evidence**

- A separate crop was not needed because the original-resolution side-by-side image keeps all three 340px-wide mode rows and their 10px notes legible.
- Measured note right edges are consistently 311px while row right edges are 322px, preserving an 11px inset.
- Note left edges are 187.375px / 187.375px / 193.234px, leaving clear separation from the mode titles at 52px.

**Required fidelity surfaces**

- Fonts and typography: existing system font stack, weights and sizes are preserved. Threshold notes remain single-line and retain the important “约” qualifier.
- Spacing and layout rhythm: header, cards, controls and radii retain the existing visual system. Vertical padding was tightened consistently; three mode rows are each 38px tall.
- Colors and visual tokens: light palette, selected purple state, recovery orange state, shadows and gradients are unchanged. Dark-mode screenshot has the same alignment and no overflow.
- Image quality and asset fidelity: existing extension icons and brand treatment are unchanged; no product imagery or icon asset was replaced.
- Copy and content: recovery copy was shortened without changing the action or warning. Mode thresholds still communicate approximate long-reply thresholds and exact conversation thresholds.

**Primary interactions tested**

- Pointer selection of “强力”.
- Keyboard `ArrowUp` navigation back to “均衡”.
- Enable switch off and on, including paused and active status rendering.
- “救援重开当前对话” success result.
- Selected, focusable, enabled and dark-mode states.

**Console**

- Browser `pageerror`: none.
- Console errors: none.

**Comparison history**

1. Initial P2: the two-line mode options caused persistent vertical overflow at 340 × 600 and hid persistent lower controls.
2. Fix: changed each option to a three-column grid, moved threshold notes to the right, shortened duplicate wording, and tightened related vertical spacing.
3. Post-fix evidence: body content 551px, root scroll height 600px, three 38px rows, all lower controls visible, and no horizontal or vertical overflow.
4. Final copy refinement: restored “约” to avoid implying that long-reply thresholds are exact; the rows still fit without wrapping.

**Findings**

- No actionable P0, P1 or P2 findings remain.

**Open Questions**

- None for the requested 340 × 600 Chrome / Edge extension-popup target.

**Implementation Checklist**

- [x] Move mode annotations to the right.
- [x] Preserve full-row click targets and radio semantics.
- [x] Keep keyboard focus and selected states.
- [x] Remove popup overflow at 340 × 600.
- [x] Verify light and dark themes.
- [x] Verify core popup interactions and console output.

**Follow-up Polish**

- No P3 follow-up is required for this iteration.

final result: passed
