import { createClient } from '@supabase/supabase-js';

function requireConfig(config) {
  if (!config?.url || !config?.anonKey) {
    throw new Error('Supabase Auth requires SUPABASE_URL and SUPABASE_ANON_KEY.');
  }
}

export function createSupabaseAuth({ url, anonKey, serviceRoleKey = null, appUrl = null }) {
  requireConfig({ url, anonKey });

  const publicAuth = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const adminAuth = serviceRoleKey
    ? createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
    : null;

  function redirectTo(pathname) {
    if (!appUrl) return undefined;
    return new URL(pathname, appUrl).toString();
  }

  async function getUser(accessToken) {
    if (!accessToken) {
      return null;
    }

    const { data, error } = await publicAuth.auth.getUser(accessToken);
    if (error || !data?.user) {
      return null;
    }

    return data.user;
  }

  return {
    async signUp({ email, password }) {
      const { data, error } = await publicAuth.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectTo('/login?verified=1'),
        },
      });
      if (error) throw error;
      return data;
    },

    async signInWithPassword({ email, password }) {
      const { data, error } = await publicAuth.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },

    async refreshSession({ refreshToken }) {
      const { data, error } = await publicAuth.auth.refreshSession({ refresh_token: refreshToken });
      if (error) throw error;
      return data;
    },

    async signOut({ accessToken, scope = 'local' }) {
      const scoped = createClient(url, anonKey, {
        global: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      const { error } = await scoped.auth.signOut({ scope });
      if (error) throw error;
    },

    async sendPasswordReset({ email }) {
      const { error } = await publicAuth.auth.resetPasswordForEmail(email, {
        redirectTo: redirectTo('/reset-password'),
      });
      if (error) throw error;
    },

    async updatePassword({ accessToken, password }) {
      const scoped = createClient(url, anonKey, {
        global: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      const { data, error } = await scoped.auth.updateUser({ password });
      if (error) throw error;
      return data;
    },

    async deleteUser({ userId }) {
      if (!adminAuth) {
        const error = new Error('Account deletion requires SUPABASE_SERVICE_ROLE_KEY on the server.');
        error.status = 503;
        throw error;
      }

      const { error } = await adminAuth.auth.admin.deleteUser(userId);
      if (error) throw error;
    },

    getUser,
  };
}
