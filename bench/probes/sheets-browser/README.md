# Univer Sheets in Vue and Chromium

Run the probe from the repository root with Node.js, npm and Chrome installed.

```bash
CHROME_BIN=/usr/bin/google-chrome bash bench/probes/sheets-browser/run.sh
```

Omit `CHROME_BIN` to use Playwright Chromium. The first run downloads the browser. The probe copies `snapshot-v1.json`, installs its locked dependencies in a temporary directory and starts Vite on a free loopback port. Vue mounts Univer into its own DOM container.

On 20 November 2026 the probe used Linux, Node 24.12.0, npm 11.6.2, Google Chrome 156.0.8078.47 and Chrome for Testing 149.0.7827.55, Vue 3.5.39, Vite 6.4.3, Playwright 1.61.1, Univer 1.5.2, React and React DOM 19.3.1, and RxJS 7.8.2.

| Action | Expected result |
| --- | --- |
| Open `vaulter-smoke` and click Summary | The facade reads 35 in B2 and the canvas draws `35.00`. |
| Select Detail!C3 with the mouse, type 7 and press Enter | C3 changes from 5 to 7, D3 from 15 to 21 and Summary!B2 to 41. The canvas draws `41.00`. |
| Call `insertRowBefore(1)` on the same workbook | C4 and D4 contain 7 and 21. The formulas become `=B4*C4` and `=SUM(Detail!D3:D4)`. The total remains 41. |

The probe observes selection, keyboard input, DOM tab changes, canvas `fillText` calls and calculation. Pixel comparison, mobile editing, menu-driven insertion, server persistence, concurrent editors and large workbooks have separate test requirements.
