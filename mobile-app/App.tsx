import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  Image,
  Linking,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  useColorScheme as useSystemColorScheme,
  ScrollView,
  StatusBar as RNStatusBar,
  Appearance,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin, User, statusCodes } from '@react-native-google-signin/google-signin';
import { useShareIntent } from 'expo-share-intent';
import { Ionicons } from '@expo/vector-icons';
import { useColorScheme, verifyInstallation } from 'nativewind';
import { OAUTH_CONFIG } from './config';
import './global.css';

// Monkey-patch Appearance.setColorScheme to prevent crashes on React Native 0.85+ (Android)
// when passing null (which happens when setting theme to 'system' in NativeWind)
if (Platform.OS === 'android') {
  const originalSetColorScheme = Appearance.setColorScheme;
  if (originalSetColorScheme) {
    Appearance.setColorScheme = (colorScheme) => {
      originalSetColorScheme(colorScheme === null ? 'unspecified' : colorScheme);
    };
  }
}

// Type definitions matching the Chrome extension schema
interface Bookmark {
  id: string;
  videoId: string;
  playlistItemId: string;
  title: string;
  thumbnail: string;
  seconds: number;
  at: string;
  saved: string;
}

interface GroupedVideo {
  videoId: string;
  title: string;
  thumbnail: string;
  bookmarks: Bookmark[];
}

type ThemeSetting = 'auto' | 'light' | 'dark';

const PLAYLIST_NAME = 'Watch Later At';
const BOOKMARKS_FILENAME = 'watchytvat-bookmarks.json';
const YT_API = 'https://www.googleapis.com/youtube/v3';
const DR_API = 'https://www.googleapis.com/drive/v3';
const DR_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const YT_DESCRIPTION_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Network Helpers
// ---------------------------------------------------------------------------
async function driveCall(method: string, endpoint: string, token: string, body: any = null) {
  const opts: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${DR_API}${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Drive API ${res.status}`);
  }
  return res.json();
}

async function ytCall(method: string, endpoint: string, token: string, body: any = null) {
  const opts: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${YT_API}${endpoint}`, opts);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `YT API ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------
function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseYouTubeUrl(url: string): { videoId: string | null; seconds: number } {
  let videoId: string | null = null;
  let seconds = 0;

  try {
    const cleanUrl = url.trim();
    
    // Parse Video ID
    if (cleanUrl.includes('youtu.be/')) {
      const parts = cleanUrl.split('youtu.be/');
      if (parts[1]) {
        videoId = parts[1].split('?')[0].split('&')[0];
      }
    } else {
      const vMatch = cleanUrl.match(/[?&]v=([^&#]+)/);
      if (vMatch) {
        videoId = vMatch[1];
      } else {
        const shortsMatch = cleanUrl.match(/youtube\.com\/shorts\/([^?&#]+)/);
        if (shortsMatch) {
          videoId = shortsMatch[1];
        } else {
          const embedMatch = cleanUrl.match(/youtube\.com\/embed\/([^?&#]+)/);
          if (embedMatch) {
            videoId = embedMatch[1];
          }
        }
      }
    }

    // Parse Timestamp (t parameter)
    const tMatch = cleanUrl.match(/[?&]t=([^&#]+)/);
    if (tMatch) {
      seconds = parseTimestampToSeconds(tMatch[1]);
    }
  } catch (error) {
    console.error('Error parsing YouTube URL:', error);
  }

  return { videoId, seconds };
}

function parseTimestampToSeconds(t: string): number {
  if (/^\d+$/.test(t)) {
    return parseInt(t, 10);
  }
  
  let totalSeconds = 0;
  const hourMatch = t.match(/(\d+)h/);
  const minMatch = t.match(/(\d+)m/);
  const secMatch = t.match(/(\d+)s/);
  
  if (hourMatch) totalSeconds += parseInt(hourMatch[1], 10) * 3600;
  if (minMatch) totalSeconds += parseInt(minMatch[1], 10) * 60;
  if (secMatch) totalSeconds += parseInt(secMatch[1], 10);
  
  if (!hourMatch && !minMatch && !secMatch) {
    const rawVal = parseInt(t, 10);
    if (!isNaN(rawVal)) return rawVal;
  }

  return totalSeconds;
}

export default function App() {
  verifyInstallation();
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessingShare, setIsProcessingShare] = useState(false);
  const [isSettingsVisible, setIsSettingsVisible] = useState(false);
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>('auto');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const { colorScheme, setColorScheme } = useColorScheme();
  const systemColorScheme = useSystemColorScheme();

  const isShareProcessingRef = useRef(false);

  // Share Intent Hooks
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

  // ---------------------------------------------------------------------------
  // Google Sign-In & Config
  // ---------------------------------------------------------------------------
  useEffect(() => {
    GoogleSignin.configure({
      webClientId: OAUTH_CONFIG.webClientId,
      iosClientId: OAUTH_CONFIG.iosClientId || undefined,
      scopes: [
        'https://www.googleapis.com/auth/youtube',
        'https://www.googleapis.com/auth/drive.appdata'
      ],
    });

    const initAuthAndTheme = async () => {
      // Init theme
      const savedTheme = await AsyncStorage.getItem('@watchytvat_theme') as ThemeSetting;
      if (savedTheme) {
        setThemeSetting(savedTheme);
        setColorScheme(savedTheme === 'auto' ? 'system' : savedTheme);
      } else {
        setThemeSetting('auto');
        setColorScheme('system');
      }

      // Check current sign in
      try {
        const hasPrevious = await GoogleSignin.hasPreviousSignIn();
        if (hasPrevious) {
          const response = await GoogleSignin.signInSilently();
          if (response.type === 'success') {
            const tokens = await GoogleSignin.getTokens();
            setUser(response.data);
            setToken(tokens.accessToken);
            await loadBookmarks(tokens.accessToken);
          } else {
            setIsLoading(false);
          }
        } else {
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Silent sign in failed', err);
        setIsLoading(false);
      }
    };

    initAuthAndTheme();
  }, []);

  const handleSignIn = async () => {
    setIsLoading(true);
    try {
      await GoogleSignin.hasPlayServices();
      const response = await GoogleSignin.signIn();
      if (response.type === 'success') {
        const tokens = await GoogleSignin.getTokens();
        setUser(response.data);
        setToken(tokens.accessToken);
        await loadBookmarks(tokens.accessToken);
      } else {
        setIsLoading(false);
      }
    } catch (err: any) {
      if (err.code === statusCodes.SIGN_IN_CANCELLED) {
        console.log('User cancelled sign in');
      } else {
        Alert.alert('Sign In Failed', err.message || 'An error occurred during sign-in.');
      }
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    setIsLoading(true);
    try {
      await GoogleSignin.signOut();
      setUser(null);
      setToken(null);
      setBookmarks([]);
      setLastUpdated(null);
      await AsyncStorage.removeItem('watchYtAtDriveFileId');
      await AsyncStorage.removeItem('watchYtAtPlaylistId');
    } catch (err: any) {
      Alert.alert('Logout Failed', err.message || 'Could not log out.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleManualRefresh = async () => {
    if (token) {
      await loadBookmarks(token);
    }
  };

  const handleOpenPlaylist = async () => {
    if (!token) return;
    try {
      setIsLoading(true);
      const playlistId = await findOrCreatePlaylist(token);

      // Ensure the playlist is 'unlisted' so it can be opened via direct link without login
      try {
        await ytCall('PUT', '/playlists?part=snippet,status', token, {
          id: playlistId,
          snippet: {
            title: PLAYLIST_NAME,
            description: 'Videos saved with timestamp by the Watch YT Videos At extension & mobile app.',
          },
          status: { privacyStatus: 'unlisted' },
        });
      } catch (err) {
        console.warn('Failed to ensure playlist is unlisted:', err);
      }

      const appUrl = `youtube://playlist?list=${playlistId}`;
      const webUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
      
      try {
        const supported = await Linking.canOpenURL(appUrl);
        if (supported) {
          await Linking.openURL(appUrl);
        } else {
          await Linking.openURL(webUrl);
        }
      } catch {
        await Linking.openURL(webUrl);
      }
    } catch (err: any) {
      Alert.alert('Error Opening Playlist', err.message || 'Could not open playlist.');
    } finally {
      setIsLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Google Drive & YouTube Data Operations
  // ---------------------------------------------------------------------------
  const getDriveFileId = async (accessToken: string): Promise<string | null> => {
    console.log('[DEBUG] getDriveFileId started');
    const cachedId = await AsyncStorage.getItem('watchYtAtDriveFileId');
    console.log('[DEBUG] getDriveFileId cachedId:', cachedId);
    if (cachedId) return cachedId;

    try {
      console.log('[DEBUG] getDriveFileId calling driveCall...');
      const data = await driveCall(
        'GET',
        `/files?spaces=appDataFolder&q=name%3D'${BOOKMARKS_FILENAME}'&fields=files(id)`,
        accessToken
      );
      console.log('[DEBUG] getDriveFileId driveCall response:', data);
      const fileId = data.files?.[0]?.id || null;
      console.log('[DEBUG] getDriveFileId fileId resolved:', fileId);
      if (fileId) {
        await AsyncStorage.setItem('watchYtAtDriveFileId', fileId);
      }
      return fileId;
    } catch (err) {
      console.error('[DEBUG] getDriveFileId driveCall error:', err);
      throw err;
    }
  };

  const loadBookmarks = async (accessToken: string) => {
    console.log('[DEBUG] loadBookmarks started');
    setIsLoading(true);
    try {
      const fileId = await getDriveFileId(accessToken);
      console.log('[DEBUG] loadBookmarks fileId:', fileId);
      if (!fileId) {
        console.log('[DEBUG] loadBookmarks: No fileId found, setting bookmarks to empty');
        setBookmarks([]);
        setLastUpdated(new Date().toLocaleString());
        return;
      }
      console.log('[DEBUG] loadBookmarks fetching file content...');
      const res = await fetch(`${DR_API}/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      console.log('[DEBUG] loadBookmarks fetch status:', res.status, 'ok:', res.ok);
      if (res.ok) {
        const data = await res.json();
        console.log('[DEBUG] loadBookmarks file content loaded:', data);
        setBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : []);
      } else {
        console.warn('[DEBUG] loadBookmarks fetch failed');
        setBookmarks([]);
      }
      setLastUpdated(new Date().toLocaleString());
    } catch (err: any) {
      console.error('[DEBUG] loadBookmarks error caught:', err);
      Alert.alert('Load Failed', 'Could not load your bookmarks from Google Drive.');
    } finally {
      setIsLoading(false);
    }
  };

  const writeBookmarksToDrive = async (accessToken: string, list: Bookmark[]) => {
    const content = JSON.stringify({ bookmarks: list });
    const fileId = await getDriveFileId(accessToken);

    if (fileId) {
      const res = await fetch(`${DR_UPLOAD}/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: content,
      });
      if (!res.ok) throw new Error(`Drive update status: ${res.status}`);
    } else {
      const boundary = 'wyta_boundary_x7z';
      const meta = JSON.stringify({ name: BOOKMARKS_FILENAME, parents: ['appDataFolder'] });
      const multipart = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        meta,
        `--${boundary}`,
        'Content-Type: application/json',
        '',
        content,
        `--${boundary}--`,
      ].join('\r\n');

      const res = await fetch(`${DR_UPLOAD}/files?uploadType=multipart`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipart,
      });
      if (!res.ok) throw new Error(`Drive create status: ${res.status}`);
      const data = await res.json();
      if (data.id) {
        await AsyncStorage.setItem('watchYtAtDriveFileId', data.id);
      }
    }
  };

  const findOrCreatePlaylist = async (accessToken: string): Promise<string> => {
    const cachedId = await AsyncStorage.getItem('watchYtAtPlaylistId');
    if (cachedId) return cachedId;

    let pageToken = '';
    do {
      const qs = `/playlists?part=snippet&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const data = await ytCall('GET', qs, accessToken);
      const match = data.items?.find((p: any) => p.snippet.title === PLAYLIST_NAME);
      if (match) {
        await AsyncStorage.setItem('watchYtAtPlaylistId', match.id);
        return match.id;
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    const created = await ytCall('POST', '/playlists?part=snippet,status', accessToken, {
      snippet: {
        title: PLAYLIST_NAME,
        description: 'Videos saved with timestamp by the Watch YT Videos At extension & mobile app.',
      },
      status: { privacyStatus: 'unlisted' },
    });
    await AsyncStorage.setItem('watchYtAtPlaylistId', created.id);
    return created.id;
  };

  const fetchVideoDetails = async (accessToken: string, videoId: string) => {
    try {
      const data = await ytCall('GET', `/videos?part=snippet&id=${videoId}`, accessToken);
      const video = data.items?.[0];
      if (video) {
        return {
          title: video.snippet.title || 'YouTube Video',
          thumbnail: video.snippet.thumbnails?.medium?.url || video.snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        };
      }
    } catch (err) {
      console.warn('Error fetching video details from YouTube API', err);
    }
    return {
      title: 'YouTube Video',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    };
  };

  const updatePlaylistDescription = async (accessToken: string, playlistId: string, list: Bookmark[]) => {
    const description = buildPlaylistDescription(list);
    await ytCall('PUT', '/playlists?part=snippet', accessToken, {
      id: playlistId,
      snippet: {
        title: PLAYLIST_NAME,
        description,
      },
    });
  };

  const saveSharedVideo = async (accessToken: string, videoId: string, seconds: number, existingBookmarks: Bookmark[]) => {
    const existingForVideo = existingBookmarks.find(b => b.videoId === videoId);
    let playlistItemId = existingForVideo?.playlistItemId || '';
    const playlistId = await findOrCreatePlaylist(accessToken);

    if (!playlistItemId) {
      try {
        const ytItem = await ytCall('POST', '/playlistItems?part=snippet', accessToken, {
          snippet: {
            playlistId,
            resourceId: { kind: 'youtube#video', videoId },
          },
        });
        playlistItemId = ytItem?.id || '';
      } catch (err) {
        console.warn('Failed to insert into YouTube playlist:', err);
      }
    }

    const { title, thumbnail } = await fetchVideoDetails(accessToken, videoId);
    const at = formatTime(seconds);

    const newBookmark: Bookmark = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      videoId,
      playlistItemId,
      title,
      thumbnail,
      seconds,
      at,
      saved: new Date().toISOString().slice(0, 10),
    };

    const updated = [newBookmark, ...existingBookmarks];
    await writeBookmarksToDrive(accessToken, updated);
    
    try {
      await updatePlaylistDescription(accessToken, playlistId, updated);
    } catch (err) {
      console.warn('Failed to update playlist description', err);
    }

    return { updated, title, at };
  };

  const removeBookmark = async (bookmarkId: string, videoId: string) => {
    if (!token) return;
    setIsLoading(true);
    try {
      const target = bookmarks.find(b => b.id === bookmarkId);
      if (!target) return;

      const remaining = bookmarks.filter(b => b.id !== bookmarkId);
      const videoStillSaved = remaining.some(b => b.videoId === videoId);

      if (target.playlistItemId && !videoStillSaved) {
        try {
          await ytCall('DELETE', `/playlistItems?id=${encodeURIComponent(target.playlistItemId)}`, token);
        } catch (err) {
          console.warn('Failed to delete playlistItem from YouTube', err);
        }
      }

      await writeBookmarksToDrive(token, remaining);
      setBookmarks(remaining);
      setLastUpdated(new Date().toLocaleString());

      const playlistId = await AsyncStorage.getItem('watchYtAtPlaylistId');
      if (playlistId) {
        await updatePlaylistDescription(token, playlistId, remaining);
      }
    } catch (err: any) {
      Alert.alert('Delete Failed', err.message || 'Could not delete bookmark.');
    } finally {
      setIsLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Share Intent Handler
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const sharedUrl = shareIntent?.webUrl || shareIntent?.text;
    if (!hasShareIntent || !sharedUrl || !token || isShareProcessingRef.current) return;

    const processIncomingShare = async () => {
      isShareProcessingRef.current = true;
      setIsProcessingShare(true);
      const { videoId, seconds } = parseYouTubeUrl(sharedUrl);

      if (!videoId) {
        Alert.alert('Invalid Link', 'Could not extract a YouTube video ID from the shared link.');
        resetShareIntent();
        setIsProcessingShare(false);
        isShareProcessingRef.current = false;
        return;
      }

      try {
        // Force refresh bookmarks first to ensure up-to-date lists
        let currentBookmarks: Bookmark[] = [];
        const fileId = await getDriveFileId(token);
        if (fileId) {
          const res = await fetch(`${DR_API}/files/${fileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (res.ok) {
            const data = await res.json();
            currentBookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
          }
        }

        const { updated, title, at } = await saveSharedVideo(token, videoId, seconds, currentBookmarks);
        setBookmarks(updated);
        setLastUpdated(new Date().toLocaleString());

        Alert.alert(
          'Video Saved',
          `Saved "${title}" at timestamp ${at} to your playlist.`
        );
      } catch (err: any) {
        console.error('Error processing share intent:', err);
        Alert.alert('Error Saving Video', err.message || 'An error occurred while saving.');
      } finally {
        resetShareIntent();
        setIsProcessingShare(false);
        isShareProcessingRef.current = false;
      }
    };

    processIncomingShare();
  }, [hasShareIntent, shareIntent, token]);

  // If user signed in and has a share intent queued, but was waiting for token
  useEffect(() => {
    if (hasShareIntent && !token && !isLoading) {
      Alert.alert('Sign In Required', 'Please sign in to Google to save the shared video.');
    }
  }, [hasShareIntent, token, isLoading]);

  // ---------------------------------------------------------------------------
  // Audio/Video Playback Launcher
  // ---------------------------------------------------------------------------
  const handleLaunchVideo = async (videoId: string, seconds: number) => {
    const appUrl = `youtube://watch?v=${videoId}&t=${seconds}`;
    const webUrl = `https://www.youtube.com/watch?v=${videoId}&t=${seconds}`;
    
    try {
      const supported = await Linking.canOpenURL(appUrl);
      if (supported) {
        await Linking.openURL(appUrl);
      } else {
        await Linking.openURL(webUrl);
      }
    } catch {
      await Linking.openURL(webUrl);
    }
  };

  // ---------------------------------------------------------------------------
  // Theme Manager
  // ---------------------------------------------------------------------------
  const handleThemeChange = async (setting: ThemeSetting) => {
    setThemeSetting(setting);
    await AsyncStorage.setItem('@watchytvat_theme', setting);
    setColorScheme(setting === 'auto' ? 'system' : setting);
  };

  const getEffectiveColorScheme = () => {
    if (themeSetting === 'auto') {
      return systemColorScheme || 'light';
    }
    return themeSetting;
  };

  // Group bookmarks by video for elegant dashboard display
  const groupedVideos = getGroupedVideos(bookmarks);
  console.log('[DEBUG] RENDER groupedVideos count:', groupedVideos.length, 'bookmarks count:', bookmarks.length);

  return (
    <SafeAreaProvider>
      <SafeAreaView className="flex-1 bg-neutral-50 dark:bg-neutral-950" edges={['bottom', 'left', 'right']}>
        <RNStatusBar
          barStyle="light-content"
          backgroundColor="#ff0000"
        />
        <StatusBar style="light" />

        {/* Header */}
        <SafeAreaView edges={['top']} className="bg-youtube shadow-md">
          <View className="h-14 flex-row items-center justify-between px-4">
            <View className="flex-row items-center gap-2">
              <Ionicons name="play-circle" size={26} color="#ffffff" />
              <Text className="text-white font-bold text-lg tracking-wide">Watch Later At</Text>
            </View>
            <View className="flex-row items-center gap-3">
              {user && (
                <TouchableOpacity
                  onPress={() => setIsSettingsVisible(true)}
                  className="p-1"
                  accessibilityLabel="Settings"
                >
                  <Ionicons name="settings-outline" size={22} color="#ffffff" />
                </TouchableOpacity>
              )}
            </View>
          </View>
        </SafeAreaView>

        {/* Second Toolbar Area */}
        {user && (
          <View className="bg-white dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 px-4 py-2.5 flex-row items-center justify-between">
            <Text className="text-xs text-neutral-500 dark:text-neutral-400">
              {lastUpdated ? `Updated ${lastUpdated}` : 'Not updated yet'}
            </Text>
            <View className="flex-row items-center gap-3">
              <TouchableOpacity
                onPress={handleOpenPlaylist}
                activeOpacity={0.7}
                className="py-1 px-2"
              >
                <Text className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">↗ Playlist</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleManualRefresh}
                disabled={isLoading}
                activeOpacity={0.7}
                className="flex-row items-center px-3 py-1.5 border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800"
              >
                <Ionicons name="refresh" size={12} color={getEffectiveColorScheme() === 'dark' ? '#d4d4d4' : '#404040'} />
                <Text className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 ml-1">Refresh</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

      {/* Main Container */}
      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 justify-center items-center">
            <ActivityIndicator size="large" color="#ff0000" />
            <Text className="mt-4 text-neutral-500 dark:text-neutral-400 font-medium">
              Loading your bookmarks...
            </Text>
          </View>
        ) : !user ? (
          /* Landing Screen (Unauthenticated) */
          <View className="flex-1 justify-center items-center px-8 bg-neutral-50 dark:bg-neutral-950">
            <View className="w-24 h-24 bg-red-100 dark:bg-red-950/40 rounded-full justify-center items-center mb-6">
              <Ionicons name="play" size={48} color="#ff0000" />
            </View>
            <Text className="text-2xl font-bold text-neutral-900 dark:text-neutral-50 text-center mb-3">
              Resume YouTube Videos
            </Text>
            <Text className="text-neutral-500 dark:text-neutral-400 text-center mb-8 leading-relaxed">
              Save your video positions in a custom private playlist. Synced with your Google account so you can resume on Chrome or Mobile.
            </Text>

            <TouchableOpacity
              onPress={handleSignIn}
              activeOpacity={0.8}
              className="w-full py-4 bg-youtube rounded-xl flex-row justify-center items-center shadow-lg shadow-red-500/20"
            >
              <Ionicons name="logo-google" size={20} color="#ffffff" className="mr-2" />
              <Text className="text-white font-semibold text-base ml-2">Sign in with Google</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* Dashboard (Authenticated) */
          <View className="flex-1">
            {/* Saving / Syncing indicator (subtle) */}
            {isProcessingShare && (
              <View className="bg-neutral-100 dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 py-2 px-4 flex-row items-center justify-center gap-2">
                <ActivityIndicator size="small" color="#ff0000" />
                <Text className="text-xs text-neutral-600 dark:text-neutral-400 font-medium">
                  Saving shared video...
                </Text>
              </View>
            )}


            {/* List */}
            {groupedVideos.length === 0 ? (
              <ScrollView
                contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}
                className="px-8"
              >
                <View className="w-16 h-16 bg-neutral-100 dark:bg-neutral-900 rounded-full justify-center items-center mb-4">
                  <Ionicons name="bookmark-outline" size={28} color="#a3a3a3" />
                </View>
                <Text className="text-neutral-800 dark:text-neutral-200 font-bold text-lg text-center mb-2">
                  No Bookmarks Yet
                </Text>
                <Text className="text-neutral-500 dark:text-neutral-400 text-center text-sm leading-relaxed mb-6">
                  Open the YouTube app, tap "Share" on any video, choose "More" or copy the link, and send it to the WatchYTAt app to save your current timestamp!
                </Text>
                {hasShareIntent && (shareIntent?.webUrl || shareIntent?.text) && (
                  <View className="bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30 rounded-xl p-4 w-full">
                    <Text className="text-xs font-semibold text-red-800 dark:text-red-400 uppercase tracking-wider mb-1">
                      Pending Share Link
                    </Text>
                    <Text className="text-neutral-600 dark:text-neutral-300 text-xs numberOfLines={2} mb-3">
                      {shareIntent.webUrl || shareIntent.text}
                    </Text>
                    <ActivityIndicator size="small" color="#ff0000" className="self-start" />
                  </View>
                )}
              </ScrollView>
            ) : (
              <FlatList
                data={groupedVideos}
                keyExtractor={(item) => item.videoId}
                contentContainerStyle={{ padding: 16 }}
                renderItem={({ item }) => {
                  console.log('[DEBUG] FlatList renderItem called for videoId:', item.videoId, 'title:', item.title);
                  return (
                    <View className="bg-white dark:bg-neutral-900 rounded-2xl p-4 mb-4 border border-neutral-100 dark:border-neutral-800/80 shadow-sm">
                      {/* Video Meta row */}
                      <View className="flex-row gap-3 items-start mb-3">
                        <Image
                          source={{ uri: item.thumbnail }}
                          className="w-24 h-14 rounded-lg bg-neutral-100 dark:bg-neutral-800"
                          resizeMode="cover"
                        />
                        <View className="flex-1">
                          <Text
                            numberOfLines={2}
                            className="text-neutral-800 dark:text-neutral-100 font-bold text-sm leading-tight"
                          >
                            {item.title}
                          </Text>
                        </View>
                      </View>

                    {/* Timestamps Wrapper */}
                    <View className="flex-row flex-wrap gap-2 pt-1 border-t border-neutral-50 dark:border-neutral-800/40">
                      {item.bookmarks.map((bookmark) => (
                        <View
                          key={bookmark.id}
                          className="flex-row items-center bg-neutral-100 dark:bg-neutral-800 rounded-full pl-3 pr-1 py-1"
                        >
                          <TouchableOpacity
                            onPress={() => handleLaunchVideo(item.videoId, bookmark.seconds)}
                            className="flex-row items-center mr-1"
                          >
                            <Ionicons name="play" size={10} color="#ff0000" />
                            <Text className="text-xs font-bold text-neutral-700 dark:text-neutral-300 ml-1">
                              {bookmark.at}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => removeBookmark(bookmark.id, item.videoId)}
                            className="p-1 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
                          >
                            <Ionicons name="close-circle" size={14} color="#a3a3a3" />
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  </View>
                )}}
              />
            )}
          </View>
        )}
      </View>

      {/* Settings Modal */}
      <Modal
        visible={isSettingsVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setIsSettingsVisible(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white dark:bg-neutral-900 rounded-t-3xl px-6 pt-5 pb-8 border-t border-neutral-100 dark:border-neutral-800">
            {/* Modal Drag indicator */}
            <View className="w-10 h-1 bg-neutral-300 dark:bg-neutral-700 rounded-full self-center mb-6" />

            {/* Header row */}
            <View className="flex-row justify-between items-center mb-6">
              <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-50">Settings</Text>
              <TouchableOpacity
                onPress={() => setIsSettingsVisible(false)}
                className="p-1 rounded-full bg-neutral-100 dark:bg-neutral-800"
              >
                <Ionicons name="close" size={20} color={getEffectiveColorScheme() === 'dark' ? '#ffffff' : '#000000'} />
              </TouchableOpacity>
            </View>

            {/* User details card */}
            {user && (
              <View className="flex-row items-center gap-3 p-4 bg-neutral-50 dark:bg-neutral-950 rounded-2xl mb-6">
                {user.user.photo ? (
                  <Image source={{ uri: user.user.photo }} className="w-10 h-10 rounded-full" />
                ) : (
                  <View className="w-10 h-10 rounded-full bg-neutral-200 dark:bg-neutral-800 justify-center items-center">
                    <Ionicons name="person" size={20} color="#a3a3a3" />
                  </View>
                )}
                <View className="flex-1">
                  <Text className="text-sm font-bold text-neutral-800 dark:text-neutral-100">
                    {user.user.name}
                  </Text>
                  <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                    {user.user.email}
                  </Text>
                </View>
              </View>
            )}

            {/* Theme Selector */}
            <Text className="text-sm font-bold text-neutral-900 dark:text-neutral-50 mb-3">Theme</Text>
            <View className="flex-row gap-2 mb-8">
              {(['auto', 'light', 'dark'] as ThemeSetting[]).map((theme) => (
                <TouchableOpacity
                  key={theme}
                  onPress={() => handleThemeChange(theme)}
                  className={`flex-1 py-3 px-4 rounded-xl border flex-row justify-center items-center gap-1.5 ${
                    themeSetting === theme
                      ? 'bg-red-50 dark:bg-red-950/20 border-youtube'
                      : 'bg-neutral-50 dark:bg-neutral-950 border-neutral-200 dark:border-neutral-800'
                  }`}
                >
                  <Ionicons
                    name={
                      theme === 'auto'
                        ? 'contrast-outline'
                        : theme === 'light'
                        ? 'sunny-outline'
                        : 'moon-outline'
                    }
                    size={16}
                    color={themeSetting === theme ? '#ff0000' : '#888888'}
                  />
                  <Text
                    className={`font-semibold capitalize text-xs ${
                      themeSetting === theme ? 'text-youtube' : 'text-neutral-500 dark:text-neutral-400'
                    }`}
                  >
                    {theme}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Sign Out Button */}
            <TouchableOpacity
              onPress={() => {
                setIsSettingsVisible(false);
                handleSignOut();
              }}
              activeOpacity={0.8}
              className="py-3 px-4 bg-neutral-100 dark:bg-neutral-800 rounded-xl flex-row justify-center items-center gap-2"
            >
              <Ionicons name="log-out-outline" size={18} color="#ff0000" />
              <Text className="text-red-500 font-bold text-sm">Sign Out from Google</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Bookmarks list grouping helper
// ---------------------------------------------------------------------------
function getGroupedVideos(list: Bookmark[]): GroupedVideo[] {
  const groupsMap = new Map<string, GroupedVideo>();
  list.forEach(b => {
    if (!groupsMap.has(b.videoId)) {
      groupsMap.set(b.videoId, {
        videoId: b.videoId,
        title: b.title,
        thumbnail: b.thumbnail,
        bookmarks: [],
      });
    }
    groupsMap.get(b.videoId)!.bookmarks.push(b);
  });
  
  // Sort bookmarks in each group by time (optional)
  const result = Array.from(groupsMap.values());
  result.forEach(g => {
    g.bookmarks.sort((a, b) => a.seconds - b.seconds);
  });
  return result;
}

// Helper to construct the YouTube playlist description (truncated to 5000 chars)
function buildPlaylistDescription(bookmarks: Bookmark[]): string {
  if (!bookmarks.length) return '—';
  const byVideo = new Map<string, { title: string; ats: string[] }>();
  bookmarks.forEach(b => {
    if (!byVideo.has(b.videoId)) {
      byVideo.set(b.videoId, { title: b.title, ats: [] });
    }
    byVideo.get(b.videoId)!.ats.push(b.at);
  });
  const lines = [...byVideo.values()].map(v => `${v.ats.join(', ')} - ${v.title}`);
  
  const kept: string[] = [];
  let len = 0;
  for (const line of lines) {
    const needed = (kept.length > 0 ? 1 : 0) + line.length;
    if (len + needed > YT_DESCRIPTION_LIMIT) break;
    kept.push(line);
    len += needed;
  }
  return kept.join('\n') || '—';
}
