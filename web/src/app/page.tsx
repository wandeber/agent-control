import { ConsoleShell } from "@/components/console-shell";
import { Providers } from "@/components/providers";

export default function Home() {
  return (
    <Providers>
      <ConsoleShell />
    </Providers>
  );
}
