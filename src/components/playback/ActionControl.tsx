import { Field } from "@decky/ui";
import type { ReactNode } from "react";

export type ActionControlProps = {
    id: string;
    label: string;
    icon: ReactNode;
    focused: boolean;
    active?: boolean;
    preferredFocus?: boolean;
    onFocusChange: (focused: boolean) => void;
    onActivate: () => void;
};

export function ActionControl({
    id,
    label,
    icon,
    focused,
    active = false,
    preferredFocus = false,
    onFocusChange,
    onActivate,
}: ActionControlProps) {
    return (
        <div
            style={{
                boxSizing: "border-box",
                width: "48px",
                height: "48px",
                minWidth: "48px",
                minHeight: "48px",
                flex: "0 0 48px",
                padding: 0,
            }}
        >
            <Field
                key={id}
                focusable
                highlightOnFocus={false}
                preferredFocus={preferredFocus}
                padding="none"
                childrenLayout="below"
                spacingBetweenLabelAndChild="none"
                onGamepadFocus={() => onFocusChange(true)}
                onGamepadBlur={() => onFocusChange(false)}
                onClick={onActivate}
            >
                <div
                    role="img"
                    aria-label={label}
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        gap: "3px",
                        boxSizing: "border-box",
                        width: "48px",
                        height: "48px",
                        borderRadius: "8px",
                        color: active ? "#1ed760" : "inherit",
                        background: focused
                            ? "rgba(255, 255, 255, 0.16)"
                            : "transparent",
                        outline: "none",
                    }}
                >
                    {icon}
                    {active && (
                        <span
                            aria-hidden="true"
                            style={{
                                background: "#1ed760",
                                borderRadius: "50%",
                                height: "4px",
                                width: "4px",
                            }}
                        />
                    )}
                </div>
            </Field>
        </div>
    );
}
