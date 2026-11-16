# UltraEdge Baylink firmware

The firmware for the **UltraEdge Baylink**: an ESP32-C3 module that links an EdgeTX radio running UltraEdge firmware to
the UltraEdge app on an Android phone over Bluetooth. It sits in the radio's external module bay, or is wired to AUX1.

**Flash a board:** https://50ur4v.github.io/ultraedge-baylink/ in Chrome or Edge on a computer, or Chrome on an
Android phone. Plug in a bare ESP32-C3 (4 MB flash) by USB, choose **Module bay** or **AUX1 port**, press Flash. No
sign-in.

**Update a Baylink you already have:** the same page has the update file for each kind. Download it on the phone and
pick it in the app under **Wireless module › Update module firmware**.

- Supported radios: https://github.com/50UR4V/edgetx-ue/blob/ultraedge/SUPPORTED-RADIOS.md
- Setting up the link: https://github.com/50UR4V/UltraEdge-app/blob/main/UserManual/16-wireless.md
- Support: https://github.com/50UR4V/UltraEdge-app/issues

This repository holds the flasher page and the firmware files only; there is no source code here. The firmware is
proprietary, under [LICENSE](LICENSE); the open-source parts it contains are listed in
[OPEN-SOURCE-NOTICES.md](OPEN-SOURCE-NOTICES.md). Current images are test builds.

© 2026 Sourav Karmakar. All rights reserved.
