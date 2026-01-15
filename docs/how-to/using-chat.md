# How to Use the Chat Feature

This guide explains how to use the chat feature to ask questions about your transcript conversations.

## Overview

The chat feature allows you to ask natural language questions about your transcript and get AI-powered answers with timestamp citations that link directly to relevant segments.

**Key Features:**
- **Rich markdown responses** with formatted text, lists, code blocks, and more
- **Inline timestamp citations** placed directly in the answer where they support the text
- Persistent chat history (survives page reloads and works across devices)
- Interactive timestamp citations with auto-play
- Rotating contextual question suggestions
- Progressive cost transparency warnings
- 50 message limit per conversation
- Export chat history as JSON
- Mobile-optimized with 44px touch targets and haptic feedback

## Starting a Chat

1. Open any completed conversation in the Viewer
2. Click the **Chat** tab in the right sidebar
3. You'll see suggested questions to get started
4. Click a suggestion or type your own question
5. Press Enter or click Send

### Question Suggestions

The chat provides contextual question suggestions that rotate after each query:

- **Empty state:** See 3 suggested questions when you first open the chat
- **After unanswerable responses:** Get fresh suggestions when the AI can't answer
- **Rotating prompts:** Suggestions change after each query to keep things fresh
- **One-tap input:** Click any suggestion to auto-fill and send

**Example Questions:**
- "What are the main topics discussed?"
- "Who are the key people mentioned?"
- "What decisions were made?"
- "Can you summarize the conversation?"
- "What action items were mentioned?"

## Understanding Chat Responses

### Markdown Formatting

Assistant responses support rich markdown formatting for better readability:

- **Bold** and *italic* text for emphasis
- Bulleted and numbered lists
- `Inline code` for technical terms
- Code blocks for longer snippets (scrollable if wide)
- Headings for structured answers
- Block quotes for referenced text
- Links to external resources

Code blocks automatically scroll horizontally if they're too wide, so they won't break the chat bubble layout.

### Inline Timestamp Citations

Timestamp buttons now appear **directly inline** with the text they support, making it easy to verify exactly which part of the transcript backs each statement.

**Example response:**
> The speaker mentioned that Q4 revenue exceeded projections **[▶ 2:15 - Sarah]**. They also discussed plans for the next quarter **[▶ 5:42 - Sarah]**.

Each inline button shows:
- A play icon
- The timestamp (MM:SS format)
- The speaker's name

### Additional Sources

If the AI cites segments that couldn't be placed inline (rare), they appear in an "Additional sources" section below the response. This ensures no citations are lost.

### Timestamp Interactions

When you click a timestamp citation (inline or in the sources section), the following happens:

1. **Auto-play:** Audio automatically starts playing from that moment
2. **Scroll:** Transcript scrolls to the referenced segment
3. **Highlight:** Segment glows with a yellow highlight for 2 seconds
4. **Seek:** Audio player seeks to the exact timestamp

**Error Recovery:**
- If a segment is missing or audio hasn't loaded yet, you'll see a helpful error tooltip
- The tooltip auto-dismisses after 3 seconds
- Each timestamp is treated independently

**Mobile-Friendly:**
- 44px minimum touch target on all devices
- Haptic feedback on supported devices (short vibration on tap)
- Smooth scroll animations

### Unanswerable Questions

If the AI determines it cannot answer based on the transcript content:
- You'll see a message indicating the question is unanswerable
- Fresh question suggestions appear below the response
- Try clicking a suggestion or rephrasing your question

### Cost Display & Warnings

The chat tracks costs transparently to help you manage usage:

**Per-Message Cost:**
Each assistant response shows its AI processing cost in small gray text (e.g., "$0.002").

**Progressive Cost Warnings:**
- **$0.50 threshold:** Yellow "Cost notice" banner appears
- **$1.25 threshold:** Orange "High cost alert" banner appears
- Cumulative cost shown across all messages in the conversation
- Warnings help you make informed decisions about continued usage

## Chat History Persistence

Your chat history is automatically saved to the cloud and persists across:
- Page reloads
- Different devices
- Browser sessions

**Loading Older Messages:**
- The chat initially loads the 10 most recent messages
- Click "Load older messages" at the top to view earlier conversations
- Messages load in batches of 10

## Message Limits

Each conversation has a **50 message limit** (user messages + AI responses combined).

### Limit Warnings

- **45-49 messages:** Yellow warning badge shows "Near limit"
- **50 messages:** Red badge shows "Limit reached" and input is disabled

### When You Hit the Limit

You have two options:

1. **Clear History:** Delete all messages to start fresh
2. **Export History:** Save your conversation before clearing

## Managing Chat History

### Clearing History

1. Click the trash icon in the chat controls bar
2. Review the confirmation modal
3. Click "Clear History" to permanently delete all messages
4. Message count resets to 0/50

**Important:** This action cannot be undone. Consider exporting first.

### Exporting History

1. Click the download icon in the chat controls bar
2. A JSON file downloads with all messages and metadata

**Export includes:**
- All messages (user + assistant)
- Timestamps
- Timestamp citations
- Processing costs
- Export date and conversation info

The JSON format is structured for easy reading and processing:

```json
{
  "conversationTitle": "Team Meeting - Q1 Planning",
  "conversationId": "abc123",
  "exportedAt": "2025-01-15T10:30:00Z",
  "messageCount": 24,
  "messages": [
    {
      "role": "user",
      "content": "What were the main action items?",
      "createdAt": "2025-01-15T10:15:00Z"
    },
    {
      "role": "assistant",
      "content": "The main action items discussed were...",
      "sources": [...],
      "costUsd": 0.002,
      "createdAt": "2025-01-15T10:15:05Z"
    }
  ]
}
```

## Tips for Better Results

1. **Start with suggestions:** Click the suggested questions to learn what the chat can do

2. **Be specific:** Instead of "Tell me about this," ask "What did Speaker 2 say about the new product launch?"

3. **Reference context:** The AI knows about speakers, terms, topics, and people mentioned in the transcript

4. **Ask follow-ups:** The AI maintains context within the conversation

5. **Use the limit wisely:** If approaching the limit, consider starting a fresh conversation or exporting important discussions

6. **Watch your costs:** Keep an eye on cumulative costs, especially for long conversations

7. **Leverage timestamps:** Click timestamp citations to hear the exact audio source

## Troubleshooting

### Messages Not Appearing

- Check your internet connection
- Refresh the page
- Verify you're signed in with the correct account

### "Load older" Button Missing

- This appears only when there are messages older than the currently displayed ones
- If you see all messages, the button won't appear

### Chat Input Disabled

- Check if you've hit the 50 message limit (look for red warning banner)
- Clear history to continue chatting

### Error Messages

If you see an error:
- Check the error message for specific details
- Common issues: network problems, rate limits, authentication
- Try refreshing the page or signing out and back in

## Privacy and Data

- Chat history is private to your account
- Messages are stored in your Firestore database
- Deleting a conversation also deletes all associated chat history
- No one else can see your chat conversations
- Analytics events track usage patterns but not message content

## Mobile Experience

The chat is optimized for mobile devices:

**Touch Targets:**
- All interactive elements are at least 44px tall (Apple/Google guidelines)
- Suggestion buttons, timestamp links, and action buttons are tap-friendly

**Haptic Feedback:**
- Suggestion taps trigger a short vibration on supported devices
- Provides tactile confirmation of interactions

**Scrolling:**
- Auto-scrolls to new messages
- Smooth scroll animations to timestamp segments
- Optimized for one-handed use

## Analytics Tracking

The chat feature tracks anonymous usage analytics to improve the experience:

**Events tracked:**
- Question submissions (length, message count)
- Assistant responses (cost, sources, unanswerable status)
- Timestamp clicks (segment ID, source context)
- Cost warning displays
- Empty state interactions

**Privacy:**
- Message content is never tracked
- All events are anonymous and aggregated
- Used only to improve the product experience

## Related Documentation

- **[Data Model Reference](../reference/data-model.md)** - Chat history data structure
- **[Architecture Reference](../reference/architecture.md)** - How chat works under the hood
