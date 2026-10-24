---
name: design-system
description: Use brand design references from the awesome-design-md library when designing or implementing CivicFix frontend interfaces. Apply consistent typography, colors, spacing, components, and visual hierarchy.
---

# CivicFix Design System Skill

## Purpose

Create polished, consistent, professional user interfaces for CivicFix using the existing awesome-design-md design-reference library.

## Reference library

The library is located at:

`C:\projects\claude\awesome-design-md\design-md`

Each brand's design guidance is stored in:

`design-md/<brand>/DESIGN.md`

Examples include Apple, Airbnb, and BMW.

## Required workflow

Before implementing or significantly redesigning a frontend page:

1. Inspect the existing CivicFix frontend structure, framework, styling system, and components.
2. Read the relevant design reference from the library.
3. Choose a reference that fits CivicFix's purpose: a trustworthy civic-service platform for citizens and municipal departments.
4. Extract applicable guidance for typography, colors, spacing, layout, borders, shadows, and interactive states.
5. Apply the guidance consistently rather than mixing unrelated design systems.
6. Adapt the reference to CivicFix instead of copying another brand's identity or branding.
7. Reuse existing project components where appropriate and maintain accessibility and responsive behavior.

## CivicFix design principles

- Trustworthy, clear, accessible, and professional.
- Easy-to-understand complaint submission and tracking.
- Clear status indicators and readable information hierarchy.
- Responsive layouts for mobile and desktop.
- Consistent forms, buttons, cards, tables, navigation, and feedback states.
- Accessible contrast, keyboard navigation, and visible focus states.

## Constraints

- Do not restructure the repository to implement a design.
- Do not change the backend or business logic for visual improvements.
- Do not install dependencies without justification.
- Do not invent design-reference files if a reference cannot be found.
- If the library is unavailable, report that and continue only with an explicitly stated fallback.
- Follow the project's existing framework, conventions, and architecture.
- Do not redesign the entire application unless requested.

## Completion report

After a design task, summarize the reference used, the main visual decisions, the files changed, and the checks performed.