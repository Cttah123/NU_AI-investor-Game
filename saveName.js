document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("clientform").addEventListener("submit", function (event) {
        event.preventDefault();

        const username = document.getElementById("username").value.trim();
        if (!username) {
            alert("Please enter a username");
            return;
        }

        localStorage.setItem("username", username);

        window.location.href = "difficulty.html";
    });
});
