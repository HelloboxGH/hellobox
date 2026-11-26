import "@/core/extensions";
import { formDetails, formPreflight, postForm } from "@/core/server/support-api/form";

type Context = { params: Promise<{ key: string }> };

// The public form. Its key is public: it can only start unverified conversations.
export const GET = async (request: Request, { params }: Context) => formDetails(request, (await params).key);
export const POST = async (request: Request, { params }: Context) => postForm(request, (await params).key);
export const OPTIONS = async (request: Request, { params }: Context) => formPreflight(request, (await params).key);
