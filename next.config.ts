import type { NextConfig } from "next";

const config:NextConfig={
  devIndicators:false,
  logging:{incomingRequests:{ignore:[
    /^\/r\//,
    /^\/api\/v1\/public\/report-shares\//,
    /^\/api\/v1\/auth\/(google|microsoft)\/callback(?:\?|$)/,
    /^\/api\/v1\/auth\/recovery\/status(?:\?|$)/,
    /^\/api\/v1\/orders\/[a-f0-9-]+\/report\/versions\/\d+\/file(?:\?|$)/i,
    /^\/api\/v1\/media\/[a-f0-9-]+(?:\/put)?(?:\?|$)/i,
    /[?&](?:sig|token)=/i,
  ]}},
};

export default config;
