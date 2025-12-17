import { Conversation } from './types';

// Helper to generate IDs
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).substr(2, 9)}`;

export const MOCK_CONVERSATION: Conversation = {
  conversationId: 'c_demo_123',
  title: 'Engineering Sync: OAuth Migration Strategy',
  createdAt: new Date().toISOString(),
  durationMs: 45000, // 45 seconds for demo loop
  status: 'complete',
  speakers: {
    'spk_1': { speakerId: 'spk_1', displayName: 'Sarah (Lead)', colorIndex: 0 },
    'spk_2': { speakerId: 'spk_2', displayName: 'Mike (Backend)', colorIndex: 1 },
    'spk_3': { speakerId: 'spk_3', displayName: 'Speaker 3', colorIndex: 2 },
  },
  terms: {
    't_oauth': {
      termId: 't_oauth',
      key: 'oauth',
      display: 'OAuth 2.0',
      definition: 'An open standard for access delegation, commonly used as a way for Internet users to grant websites or applications access to their information on other websites but without giving them the passwords.',
      aliases: ['oauth', 'open auth']
    },
    't_jwt': {
      termId: 't_jwt',
      key: 'jwt',
      display: 'JWT',
      definition: 'JSON Web Token is a proposed Internet standard for creating data with optional signature and/or optional encryption whose payload holds JSON that asserts some number of claims.',
      aliases: ['json web token', 'jwt']
    },
    't_pkce': {
      termId: 't_pkce',
      key: 'pkce',
      display: 'PKCE',
      definition: 'Proof Key for Code Exchange by OAuth Public Clients. An extension to the Authorization Code flow to prevent CSRF and code injection attacks.',
      aliases: ['pixy']
    },
    't_spa': {
      termId: 't_spa',
      key: 'spa',
      display: 'SPA',
      definition: 'Single-Page Application. A web application or website that interacts with the user by dynamically rewriting the current web page with new data from the web server, instead of the default method of a browser loading entire new pages.',
      aliases: ['single page app']
    }
  },
  topics: [
    { topicId: 'top_1', title: 'Current Auth State', startIndex: 0, endIndex: 2, type: 'main' },
    { topicId: 'top_2', title: 'The Move to PKCE', startIndex: 3, endIndex: 6, type: 'main' },
    { topicId: 'tan_1', title: 'Side note on legacy tokens', startIndex: 4, endIndex: 5, type: 'tangent', parentTopicId: 'top_2' },
    { topicId: 'top_3', title: 'Next Steps', startIndex: 7, endIndex: 8, type: 'main' },
  ],
  people: [
    { personId: 'p_1', name: 'Alex Chen', affiliation: 'Security Team', userNotes: 'Need to schedule a review with him.' },
    { personId: 'p_2', name: 'Jessica Wu', affiliation: 'Product Management' }
  ],
  segments: [
    {
      segmentId: 's_0',
      index: 0,
      speakerId: 'spk_1',
      startMs: 0,
      endMs: 5000,
      text: "Alright, let's kick off. The main agenda today is to finalize our plan for the OAuth 2.0 migration."
    },
    {
      segmentId: 's_1',
      index: 1,
      speakerId: 'spk_2',
      startMs: 5000,
      endMs: 11000,
      text: "Right. Currently, we're using the implicit flow for our SPA, which, as we know, is now considered deprecated."
    },
    {
      segmentId: 's_2',
      index: 2,
      speakerId: 'spk_1',
      startMs: 11000,
      endMs: 16000,
      text: "Exactly. Security is pushing us to adopt PKCE for better protection against interception attacks. Alex Chen mentioned this last week."
    },
    {
      segmentId: 's_3',
      index: 3,
      speakerId: 'spk_2',
      startMs: 16000,
      endMs: 22000,
      text: "Implementing PKCE is straightforward on the client, but the backend validation logic needs a refactor."
    },
    {
      segmentId: 's_4',
      index: 4,
      speakerId: 'spk_3',
      startMs: 22000,
      endMs: 27000,
      text: "Wait, quick question—does this affect the legacy long-lived tokens we issued last year?"
    },
    {
      segmentId: 's_5',
      index: 5,
      speakerId: 'spk_2',
      startMs: 27000,
      endMs: 32000,
      text: "No, those are standard JWTs signed with RS256. They'll remain valid until expiration."
    },
    {
      segmentId: 's_6',
      index: 6,
      speakerId: 'spk_1',
      startMs: 32000,
      endMs: 38000,
      text: "Good catch though. Jessica Wu from Product will probably want a documented migration path for customers."
    },
    {
      segmentId: 's_7',
      index: 7,
      speakerId: 'spk_2',
      startMs: 38000,
      endMs: 42000,
      text: "I think we can ship to staging by Friday."
    },
    {
      segmentId: 's_8',
      index: 8,
      speakerId: 'spk_1',
      startMs: 42000,
      endMs: 45000,
      text: "Perfect. Let's do it."
    }
  ],
  termOccurrences: [
    { occurrenceId: 'o_1', termId: 't_oauth', segmentId: 's_0', startChar: 55, endChar: 64 },
    { occurrenceId: 'o_2', termId: 't_spa', segmentId: 's_1', startChar: 38, endChar: 41 },
    { occurrenceId: 'o_3', termId: 't_pkce', segmentId: 's_2', startChar: 33, endChar: 37 },
    { occurrenceId: 'o_4', termId: 't_pkce', segmentId: 's_3', startChar: 13, endChar: 17 },
    { occurrenceId: 'o_5', termId: 't_jwt', segmentId: 's_5', startChar: 23, endChar: 27 },
    { occurrenceId: 'o_6', termId: 't_pkce', segmentId: 's_6', startChar: 55, endChar: 59 },
  ]
};

export const SPEAKER_COLORS = [
  'text-blue-600 bg-blue-50 border-blue-200',
  'text-emerald-600 bg-emerald-50 border-emerald-200',
  'text-violet-600 bg-violet-50 border-violet-200',
  'text-orange-600 bg-orange-50 border-orange-200',
  'text-pink-600 bg-pink-50 border-pink-200',
];
