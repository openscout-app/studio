import { createElement, forwardRef } from "react";
import { HudInput } from "hudsonkit/primitives";

export const ScoutInput = forwardRef(function ScoutInput({ className, ...props }, ref) {
  return createElement(HudInput, { ...props, ref, className: ["scout-input", className].filter(Boolean).join(" ") });
});
