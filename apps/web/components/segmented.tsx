"use client";

import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";

export function Segmented<T extends string>({
  value, onChange, options, label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList aria-label={label}>
        {options.map((option) => <TabsTab key={option.value} value={option.value}>{option.label}</TabsTab>)}
      </TabsList>
    </Tabs>
  );
}
