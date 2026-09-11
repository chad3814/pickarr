import { authAccount, authSession, authUser, authVerification } from '../db/schema.ts';

/**
 * The four tables `drizzleAdapter` is given, keyed by the model names Better
 * Auth uses internally.
 *
 * **The property keys here are the mapping, not labels.** The adapter looks a
 * model up by the key it finds on this object and a field up by the key it
 * finds on that table -- never by the SQL name -- which is what lets the
 * `user` model reach a table called `auth_user` and the `emailVerified` field
 * reach a column called `email_verified`. The repo keeps both its `auth_`
 * prefix and its snake_case convention because of that, rather than trading
 * either away; the design spec's §2 records it as measured against
 * `better-auth@1.7.3`, not read off documentation.
 *
 * Renaming one of these four keys is a runtime failure no schema test can
 * see: `test/db/schema.test.ts` compares `db/schema.ts` against the DDL, and
 * neither side knows what Better Auth calls its models.
 *
 * This is the whole of the module on purpose -- the tables themselves stay in
 * `db/schema.ts`, mirrored against migration 12 like every other table, so
 * the adapter's view of them is a second *reference* and not a second
 * definition.
 */
export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
};
