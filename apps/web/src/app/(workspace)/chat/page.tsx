import { ShoppingChat } from "@/components/shopping-chat";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ mandate?: string }>;
}) {
  const params = await searchParams;
  return (
    <ShoppingChat
      key={params.mandate ?? "default"}
      initialMandateId={typeof params.mandate === "string" ? params.mandate : ""}
    />
  );
}
