"use client";

import { Eye, EyeSlash } from "@phosphor-icons/react";
import { type ComponentProps, useState } from "react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

export function PasswordInput(props: Omit<ComponentProps<typeof InputGroupInput>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput {...props} type={visible ? "text" : "password"} />
      <InputGroupAddon align="inline-end">
        <Button
          aria-label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible(!visible)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {visible ? <EyeSlash /> : <Eye />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );
}
