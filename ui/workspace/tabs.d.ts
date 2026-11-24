import type { ReactElement } from "react";

export type NavCenterItem<Key extends string, Route> = {
  key: Key;
  label: string;
  route: Route;
  href?: string;
};

export type NavCenterConfig<Key extends string, Route> = {
  items: readonly NavCenterItem<Key, Route>[];
  activeKey: Key;
  navigate: (route: Route) => void;
  label?: string;
  className?: string;
  brandTag?: string;
  breadcrumb?: string | null;
};

export function renderNavCenter<Key extends string, Route>(config: NavCenterConfig<Key, Route>): ReactElement;
