"use client";

import { Prohibit } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type Bootstrap, call } from "@/core/client/api";
import { notifyError } from "@/core/client/notify";
import { cn } from "@/lib/utils";
import { LABEL_COLORS, LABEL_ICONS, LabelChip, type LabelColor } from "./label-style";

type Label = Bootstrap["labels"][number];

const NO_COLOR = "none";

/** Creates a label, or edits one when `label` is given. */
export function LabelDialog({
  open, onOpenChange, label, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label?: Label | null;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        {/* Keyed so each open starts from the label as it is now. */}
        {open && <LabelForm key={label?.id ?? "new"} label={label} onDone={() => { onOpenChange(false); onSaved(); }} />}
      </DialogPopup>
    </Dialog>
  );
}

function LabelForm({ label, onDone }: { label?: Label | null; onDone: () => void }) {
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState<string>(label?.color && LABEL_COLORS.some((c) => c.value === label.color) ? label.color : NO_COLOR);
  const [icon, setIcon] = useState<string>(label?.icon && LABEL_ICONS[label.icon] ? label.icon : "tag");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const look = { name: name.trim(), icon, color: color === NO_COLOR ? null : (color as LabelColor) };
    try {
      if (label) await call("/labels/update", { id: label.id, ...look });
      else await call("/labels/create", { ...look, color: look.color ?? undefined });
      onDone();
    } catch (error) {
      notifyError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Form className="contents" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{label ? "Edit label" : "New label"}</DialogTitle>
      </DialogHeader>
      <DialogPanel className="space-y-5">
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input autoFocus name="name" required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <div className="space-y-2">
          <p className="font-medium text-foreground text-sm" id="label-color">Color</p>
          <ToggleGroup
            aria-labelledby="label-color"
            className="w-full flex-nowrap justify-between gap-1"
            value={[color]}
            onValueChange={(value) => value[0] && setColor(value[0])}
          >
            <ToggleGroupItem value={NO_COLOR} aria-label="No color" className="size-7 min-w-7 rounded-full p-0">
              <Prohibit className="text-muted-foreground" />
            </ToggleGroupItem>
            {LABEL_COLORS.map((item) => (
              <ToggleGroupItem
                key={item.value}
                value={item.value}
                aria-label={item.name}
                className="size-7 min-w-7 rounded-full p-0 data-pressed:ring-2 data-pressed:ring-ring data-pressed:ring-offset-2 data-pressed:ring-offset-background"
              >
                <span aria-hidden className="size-5 rounded-full" style={{ backgroundColor: item.swatch }} />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="space-y-2">
          <p className="font-medium text-foreground text-sm" id="label-icon">Icon</p>
          <ToggleGroup
            aria-labelledby="label-icon"
            className="grid w-full grid-cols-8 gap-1"
            value={[icon]}
            onValueChange={(value) => value[0] && setIcon(value[0])}
          >
            {Object.entries(LABEL_ICONS).map(([key, Glyph]) => (
              <ToggleGroupItem
                key={key}
                value={key}
                aria-label={key.replace(/-/g, " ")}
                className={cn("aspect-square h-auto w-full min-w-0 p-0", "data-pressed:bg-brand-soft data-pressed:text-brand-foreground")}
              >
                <Glyph className="size-4.5" />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          Preview
          <LabelChip size="default" label={{ name: name.trim() || "Label", icon, color: color === NO_COLOR ? null : color }} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="submit" disabled={saving || !name.trim()}>{label ? "Save label" : "Create label"}</Button>
      </DialogFooter>
    </Form>
  );
}
