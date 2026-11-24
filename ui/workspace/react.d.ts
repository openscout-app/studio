import type { HTMLAttributes, ReactElement } from "react";

type Props = HTMLAttributes<HTMLElement>;
export function ScoutShell(props: Props): ReactElement;
export function ScoutFrame(props: Props & { product: string }): ReactElement;
export function ScoutLogo(props: Props & { product?: string }): ReactElement;
export function ScoutSideNav(props: Props & { "aria-label": string }): ReactElement;
