import type { ComponentType, SVGProps } from "react";

export interface WidgetConfig {
	left: string[];
	right: string[];
}

export const CLAUDE_NOTCH_DEFAULT_PATH = "S:\\tools\\claude-notch\\spool";

export type SettingsTab = "general" | "appearance" | "notch" | "dock" | "gaming" | "overlays" | "dictation" | "about";

export interface SettingRowProps {
	icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
	label: string;
	desc?: string;
	action?: boolean;
	danger?: boolean;
	divider?: boolean;
	onClick?: () => void;
	children?: React.ReactNode;
}
