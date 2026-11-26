import { type NextRequest, NextResponse } from 'next/server';

/**
 * Same-origin proxy to the backend. The backend URL is read at request time (API_URL), so one
 * built image works in Docker (http://api:3000) and locally, and the browser needs no CORS.
 * Only the operations endpoints are exposed.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000';

type Context = { params: Promise<{ path: string[] }> };

async function forward(req: NextRequest, { params }: Context): Promise<NextResponse> {
  const { path } = await params;
  if (path[0] !== 'events') {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }

  const target = new URL(`/${path.map(encodeURIComponent).join('/')}`, API_URL);
  target.search = req.nextUrl.search;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return NextResponse.json({ message: 'Backend unavailable' }, { status: 502 });
  }
}

export const GET = forward;
export const POST = forward;
export const dynamic = 'force-dynamic';
