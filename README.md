# UltraEdge Baylink firmware

The firmware for the **UltraEdge Baylink**: an ESP32-C3 module that links an EdgeTX radio running UltraEdge firmware
v1.2.2 to the UltraEdge app 1.7.1 on an Android phone over Bluetooth. It sits in the radio's external module bay, or is wired to AUX1.

**Flash a board:** https://ultraedge.app/flash/ in Chrome or Edge on a computer, or Chrome on an Android phone. Plug
in an ESP32-C3 board (4 MB flash) by USB, choose **Module bay** or **AUX1 port**, press Flash. No sign-in. Then
activate it in the app under **Wireless module › Activate this Baylink**: one tap with Google, or by
email.

**Update a Baylink you already have:** the same page has the update file for each kind. Download it on the phone and
pick it in the app under **Wireless module › Update module firmware**.

- Get a Baylink or build your own: https://ultraedge.app/wireless
- Supported radios: https://ultraedge.app/radios
- Setting up the link: https://github.com/50UR4V/UltraEdge-app/blob/main/UserManual/16-wireless.md
- Support: https://github.com/50UR4V/UltraEdge-app/issues

This repository holds the flasher page and the firmware files only; there is no source code here. The firmware is
proprietary, under [LICENSE](LICENSE); the open-source parts it contains are listed in
[OPEN-SOURCE-NOTICES.md](OPEN-SOURCE-NOTICES.md).

© 2026 Sourav Karmakar. All rights reserved.
