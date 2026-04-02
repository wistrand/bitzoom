# BitZoom Accessibility Review — HN Thread Style

---

**BitZoom: Deterministic graph viewer — how's the accessibility?** (bitzoom.dev)
324 points | posted 6 hours ago | 187 comments

---

**throwaway_a11y** 6 hours ago

Just did a deep-dive on the accessibility of BitZoom. It's a canvas-based graph
visualization tool, so expectations are naturally tempered, but I was surprised
at how much they got right — and a few things that really need fixing.

**The Good:**
- Every single button in the toolbar has descriptive `aria-label` (17+ of them).
  "Zoom out to coarser level", "Cycle GPU compute mode" — not just "button1".
- `aria-live="polite"` regions for dynamic announcements: zoom level changes,
  load status, graph stats. Screen readers actually get told what's happening.
- Proper landmarks everywhere: `<header role="banner">`, `<nav>`,
  `<main>`, `<aside role="complementary">`.
- `prefers-reduced-motion` media query that kills all transitions. Respect.
- A skip-link that appears on focus. Small thing, big deal.
- Native `<dialog>` elements for modals instead of div soup.
- Full light/dark theme support.
- `lang="en"` on every page. You'd be shocked how many sites miss this.

**The Bad:**
- Canvas element has `role="img" aria-label="Graph visualization canvas"` and...
  that's it. No fallback content inside the `<canvas>` tag. No `aria-description`
  linking to a data table. For a data visualization tool, this is the #1 gap.
- Custom checkboxes and sliders have `outline: none` with no replacement focus
  style. Keyboard users are flying blind.
- Touch targets: zoom buttons are 26x24px, checkboxes are 12x12px. WCAG says
  44x44px minimum. On mobile these are basically impossible to hit.
- No focus trapping in modals/panels. Open the node detail panel and Tab just
  wanders off into the void behind it.

| reply

---

> **sr_dev_daily** 5 hours ago
>
> > Custom checkboxes and sliders have `outline: none` with no replacement focus style
>
> This is the #1 sin in modern web dev and I will die on this hill. Every CSS
> reset in existence strips outlines, and 90% of developers never add them back.
> `:focus-visible` exists now. There is zero excuse.
>
> | reply

---

>> **css_grumpkin** 5 hours ago
>>
>> They actually have a `.skip-link:focus` style that's well done — accent color
>> background, white text, fixed positioning, proper z-index. So someone on the
>> team clearly knows how to write focus styles. They just... didn't apply the
>> same care to the 20+ interactive controls in the toolbar.
>>
>> | reply

---

> **graph_nerd_42** 5 hours ago
>
> The canvas accessibility problem is inherent to every canvas-based visualization.
> The real question is: what's the best fallback? Options:
>
> 1. Hidden data table that screen readers can navigate
> 2. `aria-description` with a text summary of what's visible
> 3. SVG export (they have this — press S) as the accessible alternative
> 4. All of the above
>
> They actually have an `aria-summary` table that gets populated with visible
> nodes (Name, Group, Connections columns). That's more than most canvas apps do.
> But it's not linked from the canvas element, so a screen reader user wouldn't
> know it exists.
>
> | reply

---

>> **blinddev** 5 hours ago
>>
>> As an actual screen reader user: the summary table is nice but what I really
>> want is keyboard navigation through the graph structure. And they have this!
>> Arrow keys move between nodes, `n`/`N` step through neighbors, `Home` jumps to
>> largest node, `Enter` expands details. That's genuinely thoughtful.
>>
>> The problem is discoverability. These shortcuts only work after data loads, they're
>> not documented in an accessible way, and the canvas isn't even in the tab order
>> (no `tabindex="0"`). So you'd never know any of this exists unless you read the
>> source.
>>
>> | reply

---

>>> **a11y_consulting** 4 hours ago
>>>
>>> This is the pattern I see constantly. Developers build genuine accessibility
>>> features (keyboard nav, ARIA live regions, summary tables) but forget the
>>> connective tissue. The features exist in isolation:
>>>
>>> - Canvas has keyboard shortcuts but isn't focusable via Tab
>>> - Summary table exists but isn't linked from the canvas
>>> - Node panel opens but doesn't receive focus
>>> - Modals use `<dialog>` but don't auto-focus the first control
>>>
>>> It's 80% of the way there. The last 20% is just wiring.
>>>
>>> | reply

---

> **contrast_checker_bot** 4 hours ago
>
> Ran the numbers on their dark theme:
>
> | Combination                     | Ratio  | WCAG AA |
> | ------------------------------- | ------ | ------- |
> | --text (#c8c8d8) on --bg        | ~11.5  | PASS    |
> | --text-dim (#8888a0) on --bg    | ~5.5   | PASS*   |
> | --text-dim on --surface         | ~5.0   | PASS*   |
> | Disabled buttons (opacity: 0.3) | ~3.4   | FAIL    |
> | Checkbox border on --bg         | ~1.8   | FAIL    |
> | Slider track on --bg            | ~1.8   | FAIL    |
>
> *Borderline. Fine for large text, sketchy for 12px labels.
>
> The disabled state using `opacity: 0.3` is the worst offender. Disabled doesn't
> mean invisible. Users still need to know the control exists.
>
> Checkbox and slider borders at #1e1e2e on #0a0a0f are essentially invisible.
> The custom checkbox styling (`appearance: none`) removes the native rendering
> and replaces it with a 1px border you literally cannot see.
>
> | reply

---

>> **daltonist** 4 hours ago
>>
>> Also worth noting: the heatmap visualization relies entirely on color to convey
>> density information. No patterns, no labels, no alternative encoding. If you
>> can't distinguish the colors (or can't see at all), that layer is just noise.
>>
>> They do have multiple color schemes (vivid, viridis, plasma) which is great for
>> preference, but none of them were designed with colorblindness in mind as a
>> primary concern.
>>
>> | reply

---

> **mobile_first** 3 hours ago
>
> Touch targets are genuinely bad:
>
> - Sidebar toggle: 44x44px (the only one that passes)
> - Zoom buttons: 26x24px
> - Reset buttons: 24px height
> - Checkboxes: 12x12px
> - Slider thumbs: 11-12px
>
> On a phone, interacting with those checkboxes is an exercise in frustration.
> The slider thumbs are particularly bad because they removed the native
> appearance and replaced it with an 11px custom thumb.
>
> Quick fix: `@media (pointer: coarse)` to increase sizes on touch devices.
> Don't need to change the desktop layout at all.
>
> | reply

---

> **wcag_lawyer** 3 hours ago
>
> Summarizing by WCAG 2.2 level:
>
> **Level A violations (must fix):**
> - 1.1.1 Non-text Content: Canvas lacks text alternative beyond generic label
> - 2.1.1 Keyboard: Canvas not in tab order, panels don't trap focus
> - 2.4.7 Focus Visible: Custom controls strip focus indicators
>
> **Level AA violations:**
> - 1.4.3 Contrast: Disabled states, form control borders below 3:1
> - 1.4.11 Non-text Contrast: Checkbox/slider borders below 3:1
> - 2.4.11 Focus Not Obscured: Node panel may cover focused controls
> - 2.5.8 Target Size: Multiple controls below 24x24px minimum
>
> **Things they nailed (often missed by others):**
> - 1.3.1 Info and Relationships: Proper landmarks, ARIA roles, grouping
> - 1.3.2 Meaningful Sequence: DOM order matches visual order
> - 2.4.1 Bypass Blocks: Skip link present
> - 2.4.2 Page Titled: All pages have descriptive titles
> - 3.1.1 Language of Page: lang="en" everywhere
> - 4.1.2 Name, Role, Value: Extensive ARIA labeling on controls
> - 2.3.1 Three Flashes: prefers-reduced-motion honored
>
> Honestly? This is better than 80% of web apps I audit. The ARIA work alone
> puts it ahead of most. But the canvas fallback and focus management gaps
> prevent AA conformance.
>
> | reply

---

>> **pg** 2 hours ago
>>
>> The accessibility debug mode (press 'a') is a nice touch. It adds a CSS class
>> that reveals live regions, summaries, and hidden content. Shows the developers
>> are actively thinking about this, even if they haven't closed all the gaps.
>>
>> | reply

---

> **pragmatic_dev** 2 hours ago
>
> Here's the prioritized fix list for anyone on the team reading this:
>
> **Weekend fixes (high impact, low effort):**
> 1. Add `:focus-visible` styles to all buttons, checkboxes, and sliders
> 2. Add `tabindex="0"` to the canvas element
> 3. Add `autofocus` to the first button in each `<dialog>`
> 4. Increase touch targets with `@media (pointer: coarse)` overrides
> 5. Bump disabled opacity from 0.3 to 0.5
> 6. Link the summary table from the canvas via `aria-describedby`
>
> **Next sprint (medium effort):**
> 7. Focus trap in modals and side panels
> 8. Focus restoration when panels close
> 9. Richer canvas `aria-description` that summarizes current view state
> 10. Increase checkbox/slider border contrast
>
> **Longer term:**
> 11. Table view toggle as first-class alternative to canvas
> 12. Announce node selection changes via live region
> 13. Screen reader testing with NVDA/JAWS/VoiceOver
> 14. Publish an accessibility statement
>
> | reply

---

>> **Show HN commenter** 1 hour ago
>>
>> I'll add: the keyboard navigation they built (arrow keys between nodes,
>> neighbor traversal) is genuinely one of the better graph keyboard nav
>> implementations I've seen. Most graph tools don't even try.
>>
>> But single-letter shortcuts (`a`, `c`, `f`, `l`, `s`) conflict with screen
>> reader shortcuts. These should be behind a modifier key, or only active when
>> the canvas is focused (which loops back to needing `tabindex="0"`).
>>
>> | reply

---

> **tl_dr_bot** 1 hour ago
>
> **tl;dr**: Surprisingly good ARIA and semantic HTML for a canvas app. Keyboard
> graph navigation is a standout feature. Falls down on focus management, touch
> targets, contrast on form controls, and the inevitable canvas-as-image problem.
> 80% of the way to WCAG AA. Fixable in a sprint.
>
> | reply
