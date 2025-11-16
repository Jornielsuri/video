
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality } from '@google/genai';
import { ChatStatus } from './types';
import { createBlob, decode, decodeAudioData } from './utils/audio';

// --- Helper Components defined outside the main App component ---

interface VideoFeedProps {
  localStream: MediaStream | null;
  strangerImageUrl: string;
  isChatting: boolean;
}

const VideoFeed: React.FC<VideoFeedProps> = ({ localStream, strangerImageUrl, isChatting }) => {
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  return (
    <div className="relative w-full h-full bg-black rounded-lg overflow-hidden shadow-2xl">
      {isChatting ? (
        <img src={strangerImageUrl} alt="Stranger" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gray-800">
          <p className="text-gray-400 text-lg">Waiting to connect...</p>
        </div>
      )}
      <video
        ref={localVideoRef}
        autoPlay
        muted
        playsInline
        className={`absolute bottom-4 right-4 w-1/4 max-w-[200px] h-auto rounded-md border-2 border-gray-700 transition-opacity duration-500 ${isChatting ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
};

interface ControlsProps {
  status: ChatStatus;
  onStart: () => void;
  onStop: () => void;
  onNext: () => void;
}

const Controls: React.FC<ControlsProps> = ({ status, onStart, onStop, onNext }) => {
  const getStatusText = () => {
    switch (status) {
      case ChatStatus.CONNECTING:
        return 'Connecting...';
      case ChatStatus.CONNECTED:
        return 'Connected! You are now chatting.';
      case ChatStatus.DISCONNECTED:
        return 'Chat ended.';
      case ChatStatus.ERROR:
        return 'Connection error. Please try again.';
      default:
        return 'Press Start to find a chat partner.';
    }
  };

  const isChatting = status === ChatStatus.CONNECTED || status === ChatStatus.CONNECTING;

  return (
    <div className="w-full p-4 bg-gray-900/80 backdrop-blur-sm flex items-center justify-between space-x-4">
      <p className="text-sm text-gray-300 flex-1 min-w-0">{getStatusText()}</p>
      <div className="flex space-x-2">
        {status === ChatStatus.IDLE || status === ChatStatus.DISCONNECTED || status === ChatStatus.ERROR ? (
          <button onClick={onStart} className="px-6 py-2 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 transition-colors disabled:bg-blue-800 disabled:cursor-not-allowed" disabled={status === ChatStatus.CONNECTING}>
            {status === ChatStatus.CONNECTING ? 'Starting...' : 'Start'}
          </button>
        ) : (
          <>
            <button onClick={onStop} className="px-6 py-2 bg-red-600 text-white font-semibold rounded-md hover:bg-red-700 transition-colors">
              Stop
            </button>
            <button onClick={onNext} className="px-6 py-2 bg-gray-600 text-white font-semibold rounded-md hover:bg-gray-700 transition-colors" disabled={status !== ChatStatus.CONNECTED}>
              Next
            </button>
          </>
        )}
      </div>
    </div>
  );
};


// --- Main App Component ---

export default function App() {
  const [status, setStatus] = useState<ChatStatus>(ChatStatus.IDLE);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [strangerImageUrl, setStrangerImageUrl] = useState<string>('https://picsum.photos/800/600');
  
  const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const playingSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const inputAudioProcessorRef = useRef<{ source: MediaStreamAudioSourceNode, processor: ScriptProcessorNode } | null>(null);


  const cleanup = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }
    
    if (sessionPromiseRef.current) {
        sessionPromiseRef.current.then(session => session.close());
        sessionPromiseRef.current = null;
    }
    
    if (inputAudioProcessorRef.current) {
        inputAudioProcessorRef.current.processor.disconnect();
        inputAudioProcessorRef.current.source.disconnect();
        inputAudioProcessorRef.current = null;
    }
    
    playingSourcesRef.current.forEach(source => source.stop());
    playingSourcesRef.current.clear();
    
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
        outputAudioContextRef.current.close();
    }
    outputAudioContextRef.current = null;

    nextStartTimeRef.current = 0;
  }, []);

  const startChat = useCallback(async () => {
    cleanup();
    setStatus(ChatStatus.CONNECTING);
    setStrangerImageUrl(`https://picsum.photos/800/600?random=${Date.now()}`);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Explicitly check for API_KEY
      if (!process.env.API_KEY) {
        throw new Error("API_KEY environment variable not set.");
      }
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // FIX: Cast window to `any` to support `webkitAudioContext` for older browsers without TypeScript errors.
      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      // FIX: Cast window to `any` to support `webkitAudioContext` for older browsers without TypeScript errors.
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: 'You are a random person on a video chat app. Act naturally. Chat with the user about anything. Keep your responses conversational and not too long. Sometimes be funny, sometimes serious, like a real person.',
        },
        callbacks: {
          onopen: () => {
            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              if (sessionPromiseRef.current) {
                sessionPromiseRef.current.then((session) => {
                   session.sendRealtimeInput({ media: pcmBlob });
                });
              }
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext.destination);
            inputAudioProcessorRef.current = { source, processor: scriptProcessor };
            setStatus(ChatStatus.CONNECTED);
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              const outputAudioContext = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContext.currentTime);

              const audioBuffer = await decodeAudioData(decode(audioData), outputAudioContext, 24000, 1);
              const source = outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioContext.destination);

              source.addEventListener('ended', () => {
                playingSourcesRef.current.delete(source);
              });
              
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              playingSourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
                playingSourcesRef.current.forEach(s => s.stop());
                playingSourcesRef.current.clear();
                nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: Error) => {
            console.error('Gemini Live API Error:', e);
            setStatus(ChatStatus.ERROR);
            cleanup();
          },
          onclose: () => {
            // This can be triggered by server or by client calling session.close()
            // We only set status if it's not already being handled by stop/next.
            setStatus(prev => (prev === ChatStatus.CONNECTED || prev === ChatStatus.CONNECTING) ? ChatStatus.DISCONNECTED : prev);
          },
        },
      });

    } catch (error) {
      console.error('Failed to start chat:', error);
      setStatus(ChatStatus.ERROR);
      cleanup();
    }
  }, [cleanup]);

  const handleStop = useCallback(() => {
    setStatus(ChatStatus.DISCONNECTED);
    cleanup();
  }, [cleanup]);

  const handleNext = useCallback(() => {
    // A quick disconnect message before reconnecting
    setStatus(ChatStatus.DISCONNECTED);
    setTimeout(() => {
        startChat();
    }, 100);
  }, [startChat]);

  useEffect(() => {
    // Add a cleanup function for when the component unmounts
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return (
    <div className="flex flex-col h-screen w-screen bg-gray-900 text-white font-sans">
      <header className="p-4 bg-gray-800 border-b border-gray-700">
        <h1 className="text-2xl font-bold text-center">Gemini TV</h1>
      </header>
      <main className="flex-1 p-2 md:p-4 overflow-hidden">
        <VideoFeed 
          localStream={localStream} 
          strangerImageUrl={strangerImageUrl} 
          isChatting={status === ChatStatus.CONNECTED || status === ChatStatus.CONNECTING}
        />
      </main>
      <footer className="w-full">
         <Controls status={status} onStart={startChat} onStop={handleStop} onNext={handleNext} />
      </footer>
    </div>
  );
}
