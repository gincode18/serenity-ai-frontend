import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase-server";
import { getGeminiModel } from "@/lib/ai/client";
import { ChatMessage } from "@/lib/ai/types";
import { fetchRelevantJournalEntries } from "@/lib/ai/journals";
import { fetchActivities } from "@/lib/ai/activities";
import { formatJournalEntries } from "@/lib/ai/journals";
import { formatActivities } from "@/lib/ai/activities";
import { prepareChatMessages, handleError } from "@/lib/ai/chat";
import { fetchRelevantUserContext, formatUserContext } from "@/lib/ai/user-context";

// Set the runtime to edge for better performance
export const runtime = "edge";

// Function to get chat history from telegram_messages
async function getTelegramChatHistory(chatId: string, limit: number = 10) {
  const { data, error } = await supabase
    .rpc('get_telegram_chat_history', { 
      p_chat_id: chatId,
      p_limit: limit 
    });
  
  if (error) {
    console.error("Error fetching chat history:", error);
    return [];
  }
  
  return data || [];
}

// Format telegram chat history to chat messages
function formatChatHistory(history: any[]): string {
  if (!history || history.length === 0) return "";
  
  // Format in chronological order (oldest first)
  const chronologicalHistory = [...history].reverse();
  
  let formattedHistory = chronologicalHistory.map(msg => {
    const role = msg.is_bot ? "Assistant" : "User";
    return `${role}: ${msg.content}`;
  }).join("\n\n");

  console.log(`Formatted chat history: ${formattedHistory}`);

  return formattedHistory;
}

// Function to clear chat history for a specific chat ID
async function clearChatHistory(chatId: string) {
  console.log(`Clearing chat history for chat ID: ${chatId}`);
  
  const { error } = await supabase
    .from('telegram_messages')
    .delete()
    .eq('telegram_chat_id', chatId);
    
  if (error) {
    console.error("Error clearing chat history:", error);
    throw error;
  }
  
  console.log(`Successfully cleared chat history for chat ID: ${chatId}`);
  return true;
}

// POST handler for receiving webhook updates from Telegram
export async function POST(req: Request) {
  console.log("Telegram webhook received");
  
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return new Response("Missing Telegram Bot Token", { status: 500 });
  }

  if (!process.env.GEMINI_API_KEY) {
    return new Response("Missing API key", { status: 500 });
  }

  try {
    // Parse the incoming update
    const data = await req.json();
    console.log("Telegram update:", JSON.stringify(data));
    
    // Process the message
    await processUpdate(data);
    
    // Always return 200 OK to Telegram quickly
    return new Response(JSON.stringify({ status: "OK" }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error("Error processing webhook:", error);
    
    // Still return 200 OK to avoid Telegram retrying on errors
    return new Response(
      JSON.stringify({ 
        status: "OK",
        note: "Error occurred but still returning 200 to prevent retries"
      }), 
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// Process the Telegram update
async function processUpdate(data: any) {
  try {
    // Check if this is a message with text
    if (data.message && data.message.text) {
      const chatId = data.message.chat.id;
      const userMessage = data.message.text;
      const userName = data.message.chat.username || "unknown";
      
      console.log(`Received message: '${userMessage}' from user: ${userName} (ID: ${chatId})`);

      try {
        // Find the user_id from telegram_users table
        const { data: telegramUser, error: telegramError } = await supabase
          .from('telegram_users')
          .select('user_id')
          .eq('telegram_id', userName)
          .single();

        if (telegramError || !telegramUser) {
          console.error("User not found:", telegramError);
          await sendTelegramMessage(chatId, "Sorry, your account is not linked. Please sign up on our website first.");
          return;
        }

        const userId = telegramUser.user_id;
        
        // Handle /clear command to delete chat history
        if (userMessage.trim().toLowerCase() === '/clear') {
          await clearChatHistory(chatId.toString());
          await sendTelegramMessage(chatId, "Your chat history has been cleared.");
          return;
        }
        
        const model = getGeminiModel("gemini-2.0-flash");
        
        // Store message in telegram_messages table
        await supabase.from('telegram_messages').insert({
          telegram_chat_id: chatId.toString(),
          telegram_user_id: userName,
          content: userMessage,
          is_bot: false
        });

        // Get recent chat history
        const chatHistory = await getTelegramChatHistory(chatId.toString(), 10);
        const formattedChatHistory = formatChatHistory(chatHistory);

        // Create a single message for the AI
        const messages: ChatMessage[] = [
          { role: "user", content: userMessage }
        ];

        console.log("Telegram webhook: Fetching relevant journal entries and extracting user context");
        // Get journal entries based on user message 
        // Note: This now also handles user context extraction internally
        const { entries, moodAnalysis, recommendations } = await fetchRelevantJournalEntries(userId, userMessage);
        console.log(`Telegram webhook: Found ${entries.length} relevant journal entries`);
        console.log("Telegram webhook: Mood analysis:", JSON.stringify(moodAnalysis).substring(0, 200) + "...");
        
        // Fetch and format activities
        console.log("Telegram webhook: Fetching activities");
        const activities = await fetchActivities();
        console.log(`Telegram webhook: Found ${activities.length} activities`);

        // Fetch relevant user context (including any newly extracted context from the journal entries function)
        console.log("Telegram webhook: Fetching relevant user context");
        const userContextItems = await fetchRelevantUserContext(userId, userMessage);
        console.log(`Telegram webhook: Found ${userContextItems.length} user context items:`, 
          userContextItems.map(item => item.entity_name).join(", "));

        // Format contexts
        console.log("Telegram webhook: Formatting contexts for AI input");
        const journalContext = formatJournalEntries(entries);
        const activitiesContext = formatActivities(activities);
        const userContext = formatUserContext(userContextItems);

        // Prepare chat message
        console.log("Telegram webhook: Preparing Gemini messages with context");
        const geminiMessages = prepareChatMessages(
          messages, 
          journalContext, 
          activitiesContext, 
          moodAnalysis, 
          recommendations, 
          formattedChatHistory, // Include chat history for context
          userContext // Add user context to the message
        );
        
        // Process with AI and get response
        console.log("Telegram webhook: Initializing Gemini model");
        const chat = model.startChat({ history: geminiMessages });
        console.log("Telegram webhook: Sending message to Gemini");
        const result = await chat.sendMessage(userMessage);
        const aiResponse = result.response.text();
        console.log("Telegram webhook: Received response from Gemini");
        
        // Save the bot's response to telegram_messages
        await supabase.from('telegram_messages').insert({
          telegram_chat_id: chatId.toString(),
          telegram_user_id: userName,
          content: aiResponse,
          is_bot: true
        });
        
        // Send the AI response back to the user
        await sendTelegramMessage(chatId, aiResponse);
        
      } catch (error) {
        console.error("Error processing message:", error);
        await sendTelegramMessage(chatId, "Sorry, something went wrong processing your message.");
      }
    }
  } catch (error) {
    console.error("General error in processUpdate:", error);
  }
}

// Helper function to send messages back to Telegram
async function sendTelegramMessage(chatId: string | number, text: string) {
  try {
    console.log(`Sending message to chat ID: ${chatId}`);
    
    // Limit response length to avoid Telegram API errors
    if (text.length > 4000) {
      text = text.substring(0, 3997) + "...";
    }
    
    const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(telegramApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Telegram API error: ${JSON.stringify(errorData)}`);
    }
    
    console.log("Message sent successfully");
  } catch (error) {
    console.error("Failed to send message:", error);
    
    // Try again with a simpler message if the first one failed
    try {
      const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      await fetch(telegramApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Sorry, the response was too large or took too long. Please try again with a shorter message."
        })
      });
    } catch (retryError) {
      console.error("Also failed to send simplified message:", retryError);
    }
  }
}
