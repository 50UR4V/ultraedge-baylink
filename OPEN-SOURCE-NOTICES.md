# Open-source notices — UltraEdge Baylink firmware and web flasher

The Baylink firmware (LICENSE) is proprietary. It contains these open-source components, each under its own licence.

## In the firmware image (ESP32-C3)
| Component | Licence | Source |
|---|---|---|
| ESP-IDF 5.4 (Espressif), including its bundled components used by the image (bootloader, drivers, NVS, partitions, OTA, mbedTLS) | Apache-2.0 | https://github.com/espressif/esp-idf |
| FreeRTOS kernel (as shipped in ESP-IDF) | MIT | https://github.com/espressif/esp-idf/tree/master/components/freertos |
| Apache NimBLE Bluetooth LE stack (as shipped in ESP-IDF) | Apache-2.0 | https://github.com/apache/mynewt-nimble |
| Monocypher 4.0.2 (Ed25519, SHA-512) | CC0-1.0 (or BSD-2-Clause) | https://monocypher.org |

Files marked `GPL-2.0-only OR LicenseRef-UltraEdge` (the UE-HD link headers) are the author's own code and are also
available under GPL-2.0 in the UltraEdge radio firmware: https://github.com/50UR4V/edgetx-ue

## In the web flasher page
| Component | Licence | Source |
|---|---|---|
| esptool-js 0.7.0 (Espressif) | Apache-2.0 | https://github.com/espressif/esptool-js |
| web-serial-polyfill 1.0.15 (Google) | Apache-2.0 | https://github.com/google/web-serial-polyfill |

The full Apache-2.0 licence text is in `vendor/esptool-js-0.7.0/LICENSE`. The MIT licence of FreeRTOS: Copyright (C)
Amazon.com, Inc. or its affiliates; permission is granted free of charge to use, copy, modify, merge, publish,
distribute, sublicense and sell copies, provided the copyright notice and this permission notice are included; the
software is provided "as is", without warranty of any kind.
