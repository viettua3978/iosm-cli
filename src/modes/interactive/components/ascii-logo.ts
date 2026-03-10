/**
 * ASCII art logo for the IOSM CLI startup screen.
 *
 * Renders a 5-line block-style "IOSM" logo in plain white (text color).
 */

import type { Component } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

const LOGO_LINES = [
    "██╗ ██████╗ ███████╗███╗   ███╗",
    "██║██╔═══██╗██╔════╝████╗ ████║",
    "██║██║   ██║███████╗██╔████╔██║",
    "██║██║   ██║╚════██║██║╚██╔╝██║",
    "██║╚██████╔╝███████║██║ ╚═╝ ██║",
];

export class AsciiLogoComponent implements Component {
    invalidate(): void { }

    render(width: number): string[] {
        const credit = "Created by Emil Rokossovskiy · git @rokoss21";
        const pad = Math.max(0, width - credit.length);
        return [
            ...LOGO_LINES.map((line) => theme.fg("text", line)),
            " ".repeat(pad) + theme.fg("dim", credit),
        ];
    }
}
