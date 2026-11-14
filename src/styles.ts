export const hintStyle = {
    fontSize: "12px",
    lineHeight: 1.4,
    opacity: 0.8,
} as const;

export const warningStyle = {
    backgroundColor: "rgba(255, 200, 0, 0.12)",
    border: "1px solid rgba(255, 200, 0, 0.6)",
    borderRadius: "4px",
    color: "#ffc800",
    fontSize: "12px",
    lineHeight: 1.4,
    padding: "8px 12px",
} as const;

export const outputStyle = {
    backgroundColor: "rgba(0, 0, 0, 0.25)",
    borderRadius: "4px",
    fontFamily: "monospace",
    fontSize: "11px",
    lineHeight: 1.4,
    padding: "6px 8px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
} as const;

export const errorColor = "#ff6b6b";
export const successColor = "#5bc236";

export const downloadButtonStyle = {
    backgroundColor: "rgba(0, 122, 255, 0.9)",
    border: "none",
    borderRadius: "6px",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
    padding: "10px 16px",
    width: "260px",
    textAlign: "center",
} as const;
