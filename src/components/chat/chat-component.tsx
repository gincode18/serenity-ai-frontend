"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Mic, Plus, Sparkles, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { AIVoiceInput } from "@/components/journal/ai-voice-input";
import { AwsTranscribeInput } from "@/components/journal/aws-transcribe-input";
import { useToast } from "@/hooks/use-toast";
import { ElevenLabsClient } from "elevenlabs";
import { 
  PollyClient, 
  SynthesizeSpeechCommand, 
  LanguageCode, 
  OutputFormat, 
  TextType, 
  Engine, 
  VoiceId 
} from "@aws-sdk/client-polly";

const SUGGESTED_PROMPTS = [
  "I'm feeling anxious about work. Any tips?",
  "How can I improve my sleep habits?",
  "I'm having trouble focusing. What can I do?",
  "What are some good stress-relief techniques?",
];

interface Message {
  id?: string;
  chat_id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
}

interface Chat {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message: string;
  message_count: number;
}

type VoiceProvider = "elevenlabs" | "webspeech" | "awspolly";
type VoiceRecognitionProvider = "webspeech" | "awstranscribe";

const ELEVEN_LABS_API_KEY = process.env.NEXT_PUBLIC_ELEVEN_LABS_API_KEY;
const AWS_REGION = process.env.NEXT_PUBLIC_AWS_REGION || "us-east-1";
const AWS_ACCESS_KEY_ID = process.env.NEXT_PUBLIC_AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.NEXT_PUBLIC_AWS_SECRET_ACCESS_KEY;

export default function ChatComponent() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isVoiceInputOpen, setIsVoiceInputOpen] = useState(false);
  const [voiceText, setVoiceText] = useState("");
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isVoiceResponseEnabled, setIsVoiceResponseEnabled] = useState(false);
  const [voiceProvider, setVoiceProvider] =
    useState<VoiceProvider>("webspeech");
  const [voiceRecognitionProvider, setVoiceRecognitionProvider] = useState<VoiceRecognitionProvider>("webspeech");
  const [pollyVoice, setPollyVoice] = useState("Joanna");
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isLoadingChats, setIsLoadingChats] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const speechSynthesis =
    typeof window !== "undefined" ? window.speechSynthesis : null;
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const isPlayingRef = useRef(false);
  const { toast } = useToast();

  // Scroll to bottom when messages change
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  // Fetch user's chats on component mount
  useEffect(() => {
    fetchUserChats();
  }, []);

  // Load messages when a chat is selected
  useEffect(() => {
    if (currentChatId) {
      fetchChatMessages(currentChatId);
    } else {
      setMessages([]);
    }
  }, [currentChatId]);

  const fetchUserChats = async () => {
    setIsLoadingChats(true);
    try {
      const response = await fetch("/api/chat");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setChats(data);
      
      // If there are chats, select the most recent one
      if (data.length > 0) {
        setCurrentChatId(data[0].id);
      }
    } catch (error) {
      console.error("Error fetching chats:", error);
      toast({
        title: "Error",
        description: "Failed to load chat history",
        variant: "destructive",
      });
    } finally {
      setIsLoadingChats(false);
    }
  };

  const fetchChatMessages = async (chatId: string) => {
    try {
      const response = await fetch(`/api/chat/${chatId}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      
      // Transform messages to the expected format
      const formattedMessages = data.map((msg: any) => ({
        id: msg.id,
        chat_id: msg.chat_id,
        role: msg.role === "model" ? "assistant" : msg.role,
        content: msg.content,
        created_at: msg.created_at
      }));
      
      setMessages(formattedMessages);
    } catch (error) {
      console.error("Error fetching chat messages:", error);
      toast({
        title: "Error",
        description: "Failed to load messages",
        variant: "destructive",
      });
    }
  };

  const stopCurrentAudio = () => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      URL.revokeObjectURL(currentAudioRef.current.src);
      currentAudioRef.current = null;
    }
    if (speechSynthesis) {
      speechSynthesis.cancel();
    }
    isPlayingRef.current = false;
  };

  useEffect(() => {
    return () => {
      stopCurrentAudio();
    };
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage: Message = { role: "user", content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsTyping(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          messages: [...messages, userMessage],
          chatId: currentChatId
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No reader available");
      }

      let assistantMessage = "";
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = new TextDecoder().decode(value);
        const lines = chunk.split("\n").filter((line) => line.trim() !== "");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const jsonData = JSON.parse(line.slice(5));
              if (jsonData.text) {
                assistantMessage += jsonData.text;
                setMessages((prev: any) => {
                  const updatedMessages = [
                    ...prev.slice(0, -1),
                    { role: "assistant", content: assistantMessage },
                  ];
                  return updatedMessages;
                });
                
                // Update current chat ID if this is a new chat
                if (jsonData.chatId && !currentChatId) {
                  setCurrentChatId(jsonData.chatId);
                  // Refresh the chat list
                  fetchUserChats();
                }
              }
            } catch (error) {
              console.error("Error parsing JSON:", error);
            }
          }
        }
      }

      // Final message update
      setMessages((prev: any) => {
        const updatedMessages = [
          ...prev.slice(0, -1),
          { role: "assistant", content: assistantMessage },
        ];
        return updatedMessages;
      });

      // Only speak if voice response is enabled, regardless of input method
      if (isVoiceResponseEnabled) {
        await speakText(assistantMessage);
      }

    } catch (error) {
      console.error("Error:", error);
      setMessages((prev: any) => {
        const updatedMessages = [
          ...prev,
          {
            role: "assistant",
            content: "Sorry, there was an error processing your request.",
          },
        ];
        return updatedMessages;
      });
    } finally {
      setIsTyping(false);
    }
  };

  const handleSuggestedPrompt = (prompt: string) => {
    setInput(prompt);
  };

  const handleClearChat = () => {
    setMessages([]);
    setCurrentChatId(null);
  };

  const handleNewChat = () => {
    setMessages([]);
    setCurrentChatId(null);
  };

  const handleSelectChat = (chatId: string) => {
    setCurrentChatId(chatId);
  };

  const deleteChat = async () => {
    if (!currentChatId) return;
    
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/chat/${currentChatId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      // Remove the chat from the list
      setChats(chats.filter(chat => chat.id !== currentChatId));
      
      // Clear current chat
      setMessages([]);
      setCurrentChatId(null);
      
      toast({
        title: "Success",
        description: "Chat deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting chat:", error);
      toast({
        title: "Error",
        description: "Failed to delete chat",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  const handleVoiceInput = (text: string) => {
    setVoiceText(text);
    setInput((prevInput) => prevInput + (prevInput ? " " : "") + text);
    setIsVoiceInputOpen(false);
    setIsVoiceMode(true); // Enable voice mode when using voice input
  };

  const speakTextElevenLabs = async (text: string) => {
    if (!isVoiceResponseEnabled) return;

    // Stop any currently playing audio
    stopCurrentAudio();

    try {
      const client = new ElevenLabsClient({
        apiKey: ELEVEN_LABS_API_KEY,
      });

      const audio = await client.generate({
        voice: "Rachel",
        model_id: "eleven_turbo_v2_5",
        text,
      });

      const chunks = [];
      for await (const chunk of audio) {
        chunks.push(chunk);
      }

      const blob = new Blob(chunks, { type: "audio/mpeg" });
      const audioUrl = URL.createObjectURL(blob);
      const audioElement = new Audio(audioUrl);

      currentAudioRef.current = audioElement;

      audioElement.onended = () => {
        URL.revokeObjectURL(audioUrl);
        currentAudioRef.current = null;
      };

      await audioElement.play();
    } catch (error) {
      console.error("Error generating speech:", error);
      toast({
        title: "Speech Generation Error",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const speakTextWebSpeech = (text: string) => {
    if (!speechSynthesis || isPlayingRef.current) return;
    stopCurrentAudio();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.pitch = 1.1;
    utterance.volume = 1.0;
    const loadVoices = () => {
      const voices = speechSynthesis.getVoices();
      const preferredVoices = [
        "Samantha",
        "Karen",
        "Daniel",
        "Google UK English Female",
        "Microsoft Libby Online (Natural)",
        "Microsoft Jenny Online (Natural)",
      ];
      const voice =
        voices.find(
          (v) =>
            preferredVoices.some((pv) => v.name.includes(pv)) &&
            v.lang.startsWith("en")
        ) || voices.find((v) => v.lang.startsWith("en"));
      if (voice) {
        utterance.voice = voice;
      }
    };
    loadVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = loadVoices;
    }
    isPlayingRef.current = true;
    utterance.onend = () => {
      isPlayingRef.current = false;
    };
    utterance.onerror = () => {
      isPlayingRef.current = false;
    };
    speechSynthesis.speak(utterance);
  };
  
  const speakTextPolly = async (text: string) => {
    if (!isVoiceResponseEnabled) return;
    
    // Stop any currently playing audio
    stopCurrentAudio();
    
    try {
     console.log(AWS_REGION) 
      const pollyClient = new PollyClient({
        region: AWS_REGION,
        credentials: {
          accessKeyId: AWS_ACCESS_KEY_ID || "",
          secretAccessKey: AWS_SECRET_ACCESS_KEY || ""
        }
      });
      
      // Create the Polly params object with proper typing
      const params = {
        Engine: "neural" as Engine,
        OutputFormat: "mp3" as OutputFormat,
        Text: text,
        VoiceId: pollyVoice as VoiceId,
        TextType: "text" as TextType,
        LanguageCode: "en-US" as LanguageCode
      };
      
      // Create the speech synthesis command
      const command = new SynthesizeSpeechCommand(params);
      
      // Execute the command
      const data = await pollyClient.send(command);
      
      // Convert response to audio
      if (data.AudioStream) {
        const uInt8Array = await data.AudioStream.transformToByteArray();
        const blob = new Blob([uInt8Array], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        
        const audio = new Audio(url);
        currentAudioRef.current = audio;
        
        audio.onended = () => {
          URL.revokeObjectURL(url);
          currentAudioRef.current = null;
          isPlayingRef.current = false;
        };
        
        isPlayingRef.current = true;
        await audio.play();
      }
    } catch (error) {
      console.error("Error with AWS Polly:", error);
      toast({
        title: "AWS Polly Error",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
      
      // Fallback to Web Speech API if AWS Polly fails
      speakTextWebSpeech(text);
    }
  };
  
  const speakText = (text: string) => {
    if (!isVoiceResponseEnabled) return;

    if (voiceProvider === "elevenlabs") {
      speakTextElevenLabs(text);
    } else if (voiceProvider === "awspolly") {
      speakTextPolly(text);
    } else {
      speakTextWebSpeech(text);
    }
  };

  // Format date to a readable string
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <Card className="w-full max-w-3xl mx-auto bg-white dark:bg-black shadow-xl rounded-xl overflow-hidden">
      <CardHeader className="bg-emerald-500 text-white p-6">
        <div className="flex items-center justify-between">
          <CardTitle className="text-2xl font-bold">
            Chat with Serenity-AI
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (currentChatId) {
                  window.location.href = `/chat/zen/${currentChatId}`;
                }
              }}
              disabled={!currentChatId}
              className="text-white hover:bg-emerald-600"
            >
              <Sparkles className="h-4 w-4 mr-1" />
              Zen Mode
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleNewChat}
              className="text-white hover:bg-emerald-600"
            >
              <Plus className="h-4 w-4 mr-1" />
              New Chat
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsDeleteDialogOpen(true)}
              disabled={!currentChatId}
              className="text-white hover:bg-emerald-600"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete Chat
            </Button>
          </div>
        </div>
        <div className="mt-4">
          <Select
            value={currentChatId || ""}
            onValueChange={handleSelectChat}
            disabled={isLoadingChats}
          >
            <SelectTrigger className="bg-emerald-600 text-white border-emerald-700">
              <SelectValue placeholder={isLoadingChats ? "Loading chats..." : "Select a conversation"} />
            </SelectTrigger>
            <SelectContent>
              {chats.map((chat) => (
                <SelectItem key={chat.id} value={chat.id}>
                  <div className="flex flex-col justify-center items-center">
                    <span className="font-medium">{chat.title}</span>
                    {/* <span className="text-xs text-white dark:text-emerald-500/70">
                      {formatDate(chat.updated_at)} · {chat.message_count} messages
                    </span> */}
                  </div>
                </SelectItem>
              ))}
              {chats.length === 0 && !isLoadingChats && (
                <SelectItem value="empty" disabled>
                  No conversations yet
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        <ScrollArea className="h-[60vh] pr-4" ref={scrollAreaRef}>
          {messages.length === 0 && (
            <div className="text-center text-gray-500 dark:text-emerald-500/70 mb-4">
              <p className="text-lg font-semibold">Welcome to Serenity-AI!</p>
              <p>
                I'm here to support your mental well-being. Feel free to ask me
                anything or try one of the suggested prompts below.
              </p>
            </div>
          )}
          {messages.map((m, index) => (
            <div
              key={index}
              className={`mb-4 ${
                m.role === "user" ? "text-right" : "text-left"
              }`}
            >
              <div
                className={`inline-block p-3 rounded-lg ${
                  m.role === "user"
                    ? "bg-emerald-500 text-white"
                    : "bg-gray-100 dark:bg-black border border-emerald-500/20 text-gray-900 dark:text-emerald-500"
                }`}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  className="prose dark:prose-invert max-w-none prose-emerald"
                >
                  {m.content}
                </ReactMarkdown>
              </div>
            </div>
          ))}
          {isTyping && (
            <div className="text-left">
              <span className="inline-block p-3 rounded-lg bg-gray-100 dark:bg-black border border-emerald-500/20 text-gray-900 dark:text-emerald-500">
                <Loader2 className="h-4 w-4 animate-spin" />
              </span>
            </div>
          )}
        </ScrollArea>
        {messages.length === 0 && (
          <div className="mt-6">
            <p className="text-sm font-semibold mb-2 text-gray-900 dark:text-emerald-500">
              Suggested prompts:
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_PROMPTS.map((prompt, index) => (
                <Button
                  key={index}
                  variant="outline"
                  size="sm"
                  onClick={() => handleSuggestedPrompt(prompt)}
                  className="border-emerald-500 text-gray-900 dark:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                >
                  {prompt}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter className="border-t border-gray-200 dark:border-emerald-500/20 p-4">
        <form onSubmit={handleSubmit} className="flex w-full space-x-2">
          <Input
            value={input}
            onChange={handleInputChange}
            placeholder="Type your message..."
            className="flex-grow bg-white dark:bg-black border-emerald-500 text-gray-900 dark:text-emerald-500 placeholder:text-gray-500 dark:placeholder:text-emerald-500/50"
          />
          <Dialog open={isVoiceInputOpen} onOpenChange={setIsVoiceInputOpen}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setIsVoiceInputOpen(true)}
              className="border-emerald-500"
            >
              <Mic className="h-4 w-4" />
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Voice Input</DialogTitle>
                <DialogDescription>
                  Speak to add text to your message
                </DialogDescription>
              </DialogHeader>
              {voiceRecognitionProvider === "webspeech" ? (
                <AIVoiceInput
                  onStart={() => setVoiceText("")}
                  onStop={handleVoiceInput}
                />
              ) : (
                <AwsTranscribeInput
                  onStart={() => setVoiceText("")}
                  onStop={handleVoiceInput}
                />
              )}
              <p className="mt-4 text-center text-sm text-gray-500">
                {voiceText || "Speak now..."}
              </p>
            </DialogContent>
          </Dialog>
          <Button
            type="submit"
            disabled={isTyping}
            className="bg-emerald-500 hover:bg-emerald-600 text-white"
          >
            Send
          </Button>
        </form>
      </CardFooter>
      <div className="px-4 pb-4 space-y-4">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="voice-response"
              checked={isVoiceResponseEnabled}
              onCheckedChange={(checked) =>
                setIsVoiceResponseEnabled(checked as boolean)
              }
              className="border-emerald-500 data-[state=checked]:bg-emerald-500"
            />
            <label
              htmlFor="voice-response"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-gray-900 dark:text-emerald-500"
            >
              🔈 Enable AI voice responses
            </label>
          </div>
          {isVoiceResponseEnabled && (
            <div className="space-y-2">
              <Select
                value={voiceProvider}
                onValueChange={(value: VoiceProvider) => setVoiceProvider(value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select voice provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="webspeech">Web Speech API (Free)</SelectItem>
                  <SelectItem value="awspolly">AWS Polly (Premium)</SelectItem>
                  <SelectItem value="elevenlabs">ElevenLabs (Limited Credit 🥲)</SelectItem>
                </SelectContent>
              </Select>
              
              {voiceProvider === "awspolly" && (
                <Select
                  value={pollyVoice}
                  onValueChange={(value) => setPollyVoice(value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select AWS Polly voice" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Joanna">Joanna (Female)</SelectItem>
                    <SelectItem value="Matthew">Matthew (Male)</SelectItem>
                    <SelectItem value="Salli">Salli (Female)</SelectItem>
                    <SelectItem value="Kimberly">Kimberly (Female)</SelectItem>
                    <SelectItem value="Kevin">Kevin (Male)</SelectItem>
                    <SelectItem value="Amy">Amy (Female, British)</SelectItem>
                    <SelectItem value="Brian">Brian (Male, British)</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-900 dark:text-emerald-500">
              🎤 Voice Recognition Provider
            </label>
            <Select
              value={voiceRecognitionProvider}
              onValueChange={(value: VoiceRecognitionProvider) => setVoiceRecognitionProvider(value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select voice recognition provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="webspeech">Web Speech API (Browser-based)</SelectItem>
                <SelectItem value="awstranscribe">AWS Transcribe (Premium)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <span className="text-red-500 text-sm mt-2">
          ⚠️ Voice input is supported only in the latest versions of Safari and
          Chrome browsers not supported in Brave.
        </span>
        <Button
          variant="outline"
          onClick={handleClearChat}
          className="w-full border-emerald-500 text-gray-900 dark:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
        >
          Clear Chat
        </Button>
      </div>
      
      {/* Delete Chat Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Chat</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this chat? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex justify-between">
            <Button 
              variant="outline" 
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={deleteChat}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
