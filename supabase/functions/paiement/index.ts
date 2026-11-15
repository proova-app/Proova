// Paiement par carte (Stripe Checkout) pour une mission Proova.
// Actions : checkout (crée ou réutilise la page de paiement), verify (lit le statut chez Stripe),
// refund (rembourse une réservation payée puis annulée).
// Le prix vient toujours de la base (calculé par le serveur), jamais du navigateur.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SITE = 'https://proova-app.github.io/Proova/';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SERVICE: Record<string, string> = {
  home: 'Ménage maison', office: 'Nettoyage de bureaux', car: 'Nettoyage voiture', outdoor: 'Nettoyage extérieur',
};

const out = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function adminKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (keys.default) return keys.default;
  } catch (_) { /* clés historiques */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

async function stripe(method: 'GET' | 'POST', path: string, params?: Record<string, string>) {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('Le paiement en ligne n’est pas encore activé');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' && params ? new URLSearchParams(params).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Erreur Stripe');
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return out({ error: 'Méthode non autorisée' }, 405);
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, adminKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } };
    const user = auth?.user;
    if (!user) return out({ error: 'Connexion requise' }, 401);

    const { action, mission_id } = await req.json().catch(() => ({}));
    if (typeof mission_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(mission_id)) return out({ error: 'Mission manquante' }, 400);
    const { data: m } = await db.from('missions').select('*').eq('id', mission_id).maybeSingle();
    if (!m) return out({ error: 'Mission introuvable' }, 404);
    const { data: prof } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
    const isAdmin = prof?.role === 'admin';
    if (m.client_id !== user.id && !isAdmin) return out({ error: 'Accès refusé' }, 403);

    const markPaid = async (pi: string | null) => {
      await db.from('missions').update({
        payment_status: 'paid', paid_at: new Date().toISOString(), stripe_payment_intent: pi,
      }).eq('id', m.id).eq('payment_status', 'unpaid');
      return out({ paid: true });
    };

    if (action === 'checkout') {
      if (m.payment_status === 'paid') return out({ paid: true });
      if (m.status === 'cancelled' || m.payment_status === 'refunded') return out({ error: 'Cette réservation est annulée' }, 400);
      const amount = Math.round(Number(m.price) * 100);
      if (amount < 50) return markPaid(null); // rien à payer (code promo à 100 %)
      if (m.stripe_session_id) {
        const old = await stripe('GET', `checkout/sessions/${m.stripe_session_id}`);
        if (old.payment_status === 'paid') return markPaid(old.payment_intent);
        if (old.status === 'open' && old.amount_total === amount && old.url) return out({ url: old.url });
      }
      const params: Record<string, string> = {
        mode: 'payment',
        locale: 'fr',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': String(m.currency || 'EUR').toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(amount),
        'line_items[0][price_data][product_data][name]': `Proova — ${SERVICE[m.service] || 'Nettoyage'}`,
        'line_items[0][price_data][product_data][description]': `Réservation ${m.ref}`,
        client_reference_id: m.id,
        'metadata[mission_id]': m.id,
        'metadata[ref]': m.ref,
        'payment_intent_data[description]': `Proova ${m.ref}`,
        'payment_intent_data[metadata][mission_id]': m.id,
        success_url: `${SITE}?paiement=ok#m-${m.id}`,
        cancel_url: `${SITE}#m-${m.id}`,
      };
      if (user.email && m.client_id === user.id) params.customer_email = user.email;
      const s = await stripe('POST', 'checkout/sessions', params);
      await db.from('missions').update({ stripe_session_id: s.id }).eq('id', m.id);
      return out({ url: s.url });
    }

    if (action === 'verify') {
      if (m.payment_status !== 'unpaid') return out({ paid: m.payment_status === 'paid' });
      if (!m.stripe_session_id) return out({ paid: false });
      const s = await stripe('GET', `checkout/sessions/${m.stripe_session_id}`);
      if (s.payment_status === 'paid') return markPaid(s.payment_intent);
      return out({ paid: false });
    }

    if (action === 'refund') {
      if (m.payment_status === 'refunded') return out({ refunded: true });
      if (m.status !== 'cancelled' || m.payment_status !== 'paid') return out({ error: 'Rien à rembourser' }, 400);
      let pi = m.stripe_payment_intent;
      if (!pi && m.stripe_session_id) pi = (await stripe('GET', `checkout/sessions/${m.stripe_session_id}`)).payment_intent;
      if (!pi) return out({ error: 'Payée hors du site : remboursement à faire à la main' }, 400);
      await stripe('POST', 'refunds', { payment_intent: pi, 'metadata[mission_id]': m.id });
      await db.from('missions').update({ payment_status: 'refunded' }).eq('id', m.id);
      return out({ refunded: true });
    }

    return out({ error: 'Action inconnue' }, 400);
  } catch (e) {
    return out({ error: e instanceof Error ? e.message : 'Erreur' }, 500);
  }
});
