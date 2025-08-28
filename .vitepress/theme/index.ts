import DefaultTheme from "vitepress/theme";
import Layout from "./Layout.vue";
import Note from "./components/Note.vue";
import PostImage from "./components/PostImage.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    // Register components globally for convenience
    app.component("Note", Note);
    app.component("PostImage", PostImage);
  },
};
