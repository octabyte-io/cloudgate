import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Cloudgate opens light. That is deliberate: the reference this console is read
 * from is a light product, and an operator looking at infrastructure all day is
 * buying legibility (e-console.html:60-62). Dark is one click away under the
 * avatar menu, where the reference keeps it.
 *
 * `attribute="class"` so shadcn's `.dark` variant and our role tokens switch
 * together — one class on <html> moves the whole system.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
