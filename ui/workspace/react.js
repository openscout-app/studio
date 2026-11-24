import { createElement } from "react";
import "./frame.js";
import "./side-navigation.js";

export function ScoutShell({ className, ...props }) {
  return createElement("scout-app-shell", { class: className, ...props });
}
export function ScoutFrame({ className, ...props }) {
  return createElement("scout-app-frame", { class: className, ...props });
}
export function ScoutLogo({ className, ...props }) {
  return createElement("scout-logo", { class: className, ...props });
}
export function ScoutSideNav({ className, ...props }) {
  return createElement("scout-side-nav", { class: className, ...props });
}
