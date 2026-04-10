# Nuchal AI: Clinical Posture Guardian
> **Physiology-Driven Intervention for Forward Head Posture (FHP)**

## 1. Clinical Foundation
* **Research Basis:** Kim et al. (2018).
* **Intervention Logic:** $$Y = 51.952 - (0.667 \times \text{CVA} + 0.342 \times \text{Flexion})$$
* **Thresholds:**
    * **Safe:** $> 52^\circ$
    * **Warning:** $48^\circ - 52^\circ$
    * **Intervention (Screen Blur):** $\le 48^\circ$

## 2. Technical Stack (The 5-Stack)
* **Eyes:** MediaPipe (Left-Side Landmarks 7 & 11) via WebAssembly.
* **Skeleton:** Tauri (Desktop Bridge).
* **Muscle:** Rust (High-speed math & system-level control).
* **Skin:** Next.js + TypeScript (Dashboard & UI).
* **Memory:** SQLite (Posture logs).

## 3. Current Status
Environment setup complete on Acer Nitro. Scaffolding finished with Next.js/Rust integration.