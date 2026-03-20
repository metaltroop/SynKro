import { useAppStore } from './store/useAppStore';
import { FileUploader } from './components/FileUploader';
import { AudioPlayer } from './components/AudioPlayer';
import { TextViewer } from './components/TextViewer';

function App() {
  const { currentBook } = useAppStore();

  return (
    <div className="min-h-screen bg-zinc-950 text-slate-200 font-sans selection:bg-purple-500/30 flex flex-col">
      {!currentBook ? (
        <FileUploader />
      ) : (
        <>
          <TextViewer />
          <AudioPlayer />
        </>
      )}
    </div>
  );
}

export default App;
