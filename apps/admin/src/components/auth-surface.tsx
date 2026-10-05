export function AuthSurface({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main
      id="main"
      className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 sm:px-8"
    >
      <section className="w-full max-w-[480px] rounded-3xl border bg-card p-6 sm:p-10">
        <p className="mb-8 text-sm font-medium">
          MandatePay{" "}
          <span className="ml-2 rounded-md bg-accent px-2 py-1 text-xs">Admin · Sandbox</span>
        </p>
        <h1 className="font-editorial text-3xl leading-tight sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
        <div className="mt-7">{children}</div>
      </section>
    </main>
  );
}
